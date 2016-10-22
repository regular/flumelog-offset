var fs = require('fs')

var isBuffer = Buffer.isBuffer
var Notify = require('pull-notify')
var Live = require('pull-live')
var pull = require('pull-stream/pull')
var Map = require('pull-stream/throughs/map')

var Eventually = require('eventually')

var Blocks = require('block-reader')
var isInteger = Number.isInteger

function frame (data) {
  var length = data.reduce(function (total, e) { return total + e.value.length }, 0)
  var b = new Buffer(length + data.length * 8)
  var offset = 0
  for(var i = 0; i < data.length; i++) {
    var item = data[i]
    //mutate the items
    var buf = item.value
    item.offset = 0 + offset
    console.log(buf.length, buf)
    b.writeUInt32BE(buf.length, 0 + offset) //start
    b.writeUInt32BE(buf.length, 4+buf.length + offset) //end
    item.value.copy(b, 4 + offset, 0, buf.length)
    offset += buf.length + 8
  }
  return b
}

function format (keys, values, key, value) {
  return (
    keys !== false
    ? values !== false
      ? {key: key, value: value}
      : key
    : value
  )
}

module.exports = function (file, length) {

  var since = Eventually()
  var notify = Notify()
  length = length || 1024
  var blocks = Blocks(file, length, 'a+')

  var queue = [], writing = false

  function write () {
    if(writing) return
    if(!queue.length) return
    writing = true
    var data = []
    var framed = frame(queue)
    var _queue = queue
    queue = []
    blocks.append(framed, function (err, _offset) {
      writing = false
      while(_queue.length) {
        var q = _queue.shift()
        var o = (_offset - framed.length) + q.offset
        q.cb(err, o)
      }
      //updates since.
      if(queue.length) write()
    })
  }

  var offset = blocks.offset
  var log
  return log = {
    offset: offset,
    //create a stream between any two records.
    //read the first value, then scan forward or backwards
    //in the direction of the log

    //using pull-live this way means that things added in real-time are buffered
    //in memory until they are read, that means less predictable memory usage.
    //instead, we should track the offset we are up to, and wait if necessary.
    stream: function (opts) {
      opts = opts || {}
      var cursor
      var reverse = !!opts.reverse
      var get = reverse ? log.getPrevious : log.get
      var diff = reverse ? -1 : 1
      var live = opts.live
      if(!reverse && opts.gte == null) {
        cursor = 0
      }
      else
        cursor = reverse ? opts.lt : opts.gte

      function next (cb) {
        get(cursor, function (err, value, length) {
          if(!value.length) throw new Error('read empty value')
          _cursor = cursor
          cursor += (length * diff)
          cb(err, format(opts.keys, opts.value, _cursor, value))
        })
      }

      return function (abort, cb) {
        offset.once(function (_offset) {
          //if(_offset < cursor) //throw new Error('offset smaller than cursor')
          if(cursor == null && reverse)
            offset.once(function (_offset) {
              cursor = _offset
              next(cb)
            })
          else if(reverse ? cursor > 0 : cursor < _offset) next(cb)
          else if(reverse ? cursor <= 0 : cursor >= _offset) {
            if(!live) cb(true)
            else offset.once(function (_offset) {
              if(cursor == _offset) throw new Error('expected offset to update')
              next(cb)
            }, false)
          }
          else
            throw new Error('should never happen: cursor is invalid state:'+cursor+' offset:'+_offset)
        })
      }
    },

    //if value is an array of buffers, then treat that as a batch.
    append: function (value, cb) {
      //TODO: make this like, actually durable...
      if(Array.isArray(value)) {
        var offsets = []
        value.forEach(function (v) {
          queue.push({value: v, cb: function (err, offset) {
            offsets.push(offset)
            if(offsets.length === value.length) {
              for(var i = 0; i < offsets.length; i++)
                notify({key: offsets[i], value: value[i]})
              cb(null, offsets)
            }
          }})
        })

        return write()
      }
      if(!isBuffer(value)) throw new Error('value must be a buffer')
      queue.push({value: value, cb: function (err, _offset) {
        if(err) return cb(err)
        notify({key: offset, value: value})
        cb(null, _offset)
      }})
      write()
    },
    get: function (_offset, cb) {
      if(!isInteger(_offset)) throw new Error('get: offset must be integer')
      //read the block that offset is in.
      //if offset is near the end of the block, read two blocks.
      blocks.readUInt32BE(_offset, function (err, length) {
        if(err) return cb(err)
        blocks.read(_offset + 4, _offset + 4 + length, function (err, value) {
          if(value.length !== length) throw new Error('incorrect length, expected:'+length+', was:'+value.length)
          cb(err, value, length + 8)
        })
      })
    },
    //get the record _before_ the given offset.
    getPrevious: function (_offset, cb) {
      //don't read before start of file...
      if(!isInteger(_offset)) throw new Error('getPrevious: offset must be integer')

      _offset = _offset || blocks.size()
      if(_offset == 0) return cb(new Error('attempted read previous to first object'))
      blocks.readUInt32BE(_offset - 4, function (err, length) {
        if(err) return cb(err)
        blocks.read(_offset - 4 - length, _offset - 4, function (err, value) {
          cb(err, value, length + 8)
        })
      })
    },
  }
}

