"""Run using the Python environment containing Aim (no Aim source build needed)."""
import argparse
import uvicorn
from backend.app import create_app

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Read-only Aim metrics viewer')
    parser.add_argument('--repo', required=True)
    parser.add_argument('--port', type=int, default=43801)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--cache-mib', type=int, default=512)
    args = parser.parse_args()
    if args.cache_mib < 1:
        parser.error('--cache-mib must be positive')
    uvicorn.run(create_app(args.repo, args.cache_mib), host=args.host, port=args.port)
