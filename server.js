'use strict';

var ms = require('ms');
var mongojs = require('mongojs');
var raven = require('raven');
var readPipermail = require('./lib/read-pipermail.js');
var bot = require('./index.js');

// Make sure we at least know the source and DB uri
if (!process.env.PIPERMAIL_SOURCE) {
  throw new Error('You must specify the "PIPERMAIL_SOURCE" environment variable');
}
if (!process.env.PIPERMAIL_DATABASE) {
  throw new Error('You must specify the "PIPERMAIL_DATABASE" environment variable');
}

var src = process.env.PIPERMAIL_SOURCE;
var db = mongojs(process.env.PIPERMAIL_DATABASE, ['log', 'headers', 'contents', 'topics']);


// Basic info to print on the index url for the bot
var settings = 'last-reboot:  ' + (new Date()).toISOString() + '\n' +
               'source:       ' + src + '\n' +
               'database:     ' + process.env.PIPERMAIL_DATABASE.replace(/^.*@/,'')
var lastRun = 'no old runs to display'
var lastStart = 'never started'
var lastEnd = 'never finished'

// If we're using raven as a middleware logger for express, set that up.
var ravenClient = process.env.PIPERMAIL_RAVEN ?
    new raven.Client(process.env.PIPERMAIL_RAVEN) :
    null;
if (ravenClient) {
  ravenClient.patchGlobal(function (logged, err) {
    console.error(err.stack || err);
    process.exit(1);
  });
}

// onError, write to console and raven (if it's setup)
function onError(err) {
  console.error(err.stack || err.message || err);
  if (ravenClient) {
    if (typeof err === 'string') {
      ravenClient.captureMessage(err);
    } else {
      ravenClient.captureError(err);
    }
  }
}

// the run function
function run() {
  // record the current time as the lastStart
  lastStart = (new Date()).toISOString();

  // either use the ENV var for months, or if today is 1st through 4th of the month,
  // get the last two months, otherwise just the last month
  var defaultMonths = process.env.PIPERMAIL_MONTHS || ((new Date()).getDate() < 5 ? 2 : 1);

  // number of months that will be fetch at the same time
  var parallel = process.env.PIPERMAIL_PARALLEL || 1;

  // return bot(), which is the module export of index.js, giving it the source, db, onError, 
  // and the months and parallel, which are both coerced to the Number type.
  return bot({
    source: src,
    db: db,
    months: +defaultMonths,
    parallel: +parallel,
    onError: onError

  // once bot() is resolved...
  }).then(function () {
    // mark the last end using the current timestamp
    lastEnd = (new Date()).toISOString()

    // if there was a db (lol?), insert a new entry in the `log` collection
    // that demarkates the timespan of the last run.
    if (db) {
      db.log.insert({
        type: 'bot-run',
        start: new Date(lastStart),
        end: new Date(lastEnd)
      }, {safe: true}, function (err) {
        if (err) {
          onError(err)
        }
      })
    }

  });
}

// invoke maintain. it's definition follows
maintain()
function maintain() {
  // call run, and when the promis is resolved...
  run().done(function () {
    // if the was a previous run since this bot started, let's record he difference
    // between lastEnd and lastStart. This value is only used on the index page stats.
    if (lastEnd != 'never finished') {
      lastRun = ms(new Date(lastEnd).getTime() - new Date(lastStart).getTime());
    }
    // now wait 1 minute, and run maintain() again.
    setTimeout(maintain, ms('60s'));
  }, function (err) {
    // if there was an error, console.log it, wait 1 minute, and run maintain() again.
    onError(err);
    setTimeout(maintain, ms('60s'));
  })
}

// let's create a super simple http server for displaying stats
var http = require('http');

// when a request comes in, let's...
http.createServer(function (req, res) {
  // start with at 200 status
  var status = 200;
  // if we haven't finished a run since the script was started, set the status to 503
  if (lastEnd === 'never finished') {
    status = 503
  // or, if it's been more than 20 minutes since the lastEnd, set the status to 503,
  // console.log 'Timeout triggering restart', wait 500ms and then exit.
  // (This seems weird.)
  } else if (Date.now() - (new Date(lastEnd)).getTime() > ms('20 minutes')) {
    status = 503
    onError('Timeout triggering restart');
    setTimeout(function () {
      // allow time for the error to be logged
      process.exit(1);
    }, 500);
  }

  // otherwise, just generate some plain text
  res.writeHead(status, {'Content-Type': 'text/plain'});
  // if we're 503 (Service Unavailable)
  var warning = status === 503 ? 'WARNING: server behind on processing\n\n' : '';
  var currentRun = lastStart > lastEnd ? ms(Date.now() - new Date(lastStart).getTime()) : '-'
  res.end(warning + settings + '\n\n' +
          'last-start:   ' + lastStart + '\n' +
          'last-end:     ' + lastEnd + '\n' +
          'pervious-run: ' + lastRun + '\n' +
          'current-run:  ' + currentRun + '\n' +
          'status:       ' + readPipermail.getStatus() + '\n\n' +
          'current-time: ' + (new Date()).toISOString());
}).listen(process.env.PORT || 3000);

