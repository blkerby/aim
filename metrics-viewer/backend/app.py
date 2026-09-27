import asyncio
import math
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .envelope import frame, summarize
from .reader import Reader


class RunsRequest(BaseModel):
    runs: list[str] = Field(max_length=4096)


class SeriesRequest(RunsRequest):
    metric: str = Field(max_length=2048)
    domain: tuple[float, float]
    width: int = Field(ge=1, le=32768)
    scale: Literal['linear', 'log'] = 'linear'

    @field_validator('domain')
    @classmethod
    def check_domain(cls, domain):
        import math
        if not all(math.isfinite(v) for v in domain) or domain[0] >= domain[1]:
            raise ValueError('Expected a finite increasing step range')
        return domain


def create_app(repo, cache_mib=512, reader=None):
    reader = reader or Reader(repo, cache_mib)
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='aim-viewer-read')
    slots = asyncio.Semaphore(2)

    async def work(fn, *args):
        # Shield running jobs: cancellation must not release a slot while its
        # thread is still using a DB. Waiters are cancellable before submission.
        await slots.acquire()
        future = asyncio.get_running_loop().run_in_executor(pool, fn, *args)
        future.add_done_callback(lambda _: slots.release())
        return await asyncio.shield(future)

    @asynccontextmanager
    async def lifespan(app):
        yield
        pool.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(title='Aim metrics viewer', lifespan=lifespan)
    app.state.reader = reader

    async def validate(runs):
        try:
            await work(reader.validate_runs, runs)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get('/api/runs')
    async def runs():
        return {'repo': str(reader.root), 'runs': await work(reader.runs)}

    @app.post('/api/metrics')
    async def metrics(body: RunsRequest):
        await validate(body.runs)
        return await work(reader.metrics, list(dict.fromkeys(body.runs)))

    def read_frame(run, body):
        try:
            revision, x, y = reader.series(run, body.metric)
            summary = summarize(x, y, body.domain, body.width, body.scale == 'log')
            header = {'run': run, 'status': 'ok', 'revision': revision,
                      'width': body.width, 'domain': body.domain, 'scale': body.scale,
                      'rawCount': summary['rawCount'], 'invalidCount': summary['invalidCount'],
                      'bounds': summary['bounds'], 'latestStep': float(x[-1]) if len(x) else None,
                      'latestValue': float(y[-1]) if len(y) and math.isfinite(y[-1]) else None,
                      'boundaries': summary['boundaries'],
                      'totalCount': len(x)}
            return frame(header, summary)
        except KeyError:
            return frame({'run': run, 'status': 'missing', 'error': 'Metric not present in this run.'})
        except Exception as exc:
            # Do not confuse exhaustion, transient reads, or missing files with
            # corruption. No repairs/deletions are performed by this viewer.
            return frame({'run': run, 'status': 'error', 'error': str(exc)})

    @app.post('/api/series')
    async def series(body: SeriesRequest, request: Request):
        await validate(body.runs)

        async def stream():
            for run in dict.fromkeys(body.runs):
                if await request.is_disconnected():
                    break
                yield await work(read_frame, run, body)

        return StreamingResponse(stream(), media_type='application/octet-stream',
                                 headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})

    @app.get('/api/stats')
    async def stats():
        return reader.stats()

    dist = Path(__file__).resolve().parents[1] / 'dist'
    if dist.is_dir():
        app.mount('/', StaticFiles(directory=dist, html=True), name='client')
    else:
        @app.get('/')
        async def unbuilt():
            return {'message': 'Build the client with npm run build, or use npm run dev.'}
    return app
