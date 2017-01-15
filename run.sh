#!/bin/sh
export PYTHONPATH=sample
exec sample/virtualenv/sample/bin/gunicorn sample:app --bind 127.0.0.1:$1 --pid $2
