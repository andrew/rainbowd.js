import datetime
import time

import flask
from flask import Response
app = flask.Flask(__name__)


now = datetime.datetime.now()


@app.route('/')
def index():
    return "Hello! This spawned at %s" % str(now)


@app.route('/slow')
def slow():
    def doit():
        yield "Hello! This spawned at %s<br>" % str(now)

        # Last as long as Gunicorn timeout allows
        for n in range(1, 31):
            time.sleep(1)
            yield "%s...<br>" % n
    return Response(doit())
