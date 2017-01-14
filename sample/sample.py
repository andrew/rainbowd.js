import datetime

import flask
app = flask.Flask(__name__)


now = datetime.datetime.now()


@app.route('/')
def index():
    return "Hello! This spawned at %s" % str(now)
