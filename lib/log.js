'use strict'

const Progress = require('are-we-there-yet')
const Gauge = require('gauge')
const EE = require('events').EventEmitter
const log = exports = module.exports = new EE()
const util = require('util')

const setBlocking = require('set-blocking')
const consoleControl = require('console-control-strings')

setBlocking(true)
let stream = process.stderr

Object.defineProperty(log, 'stream', {
    set: function (newStream) {
        stream = newStream
        if (this.gauge) {
            this.gauge.setWriteTo(stream, stream)
        }
    },
    get: function () {
        return stream
    },
})

let colorEnabled
log.useColor = function () {
    return colorEnabled != null ? colorEnabled : stream.isTTY
}

log.enableColor = function () {
    colorEnabled = true
    this.gauge.setTheme({hasColor: colorEnabled, hasUnicode: unicodeEnabled})
}
log.disableColor = function () {
    colorEnabled = false
    this.gauge.setTheme({hasColor: colorEnabled, hasUnicode: unicodeEnabled})
}

log.level = 'info'
log.timestamp = true

log.gauge = new Gauge(stream, {
    enabled: false,
    theme: {hasColor: log.useColor()},
    template: [
        {type: 'progressbar', length: 20},
        {type: 'activityIndicator', kerning: 1, length: 1},
        {type: 'section', default: ''},
        ':',
        {type: 'logline', kerning: 1, default: ''},
    ],
})

log.tracker = new Progress.TrackerGroup()
log.progressEnabled = log.gauge.isEnabled()

let unicodeEnabled

log.enableUnicode = function () {
    unicodeEnabled = true
    this.gauge.setTheme({hasColor: this.useColor(), hasUnicode: unicodeEnabled})
}

log.disableUnicode = function () {
    unicodeEnabled = false
    this.gauge.setTheme({hasColor: this.useColor(), hasUnicode: unicodeEnabled})
}

log.setGaugeThemeset = function (themes) {
    this.gauge.setThemeset(themes)
}

log.setGaugeTemplate = function (template) {
    this.gauge.setTemplate(template)
}

log.enableProgress = function () {
    if (this.progressEnabled || this._paused) {
        return
    }

    this.progressEnabled = true
    this.tracker.on('change', this.showProgress)
    this.gauge.enable()
}

log.disableProgress = function () {
    if (!this.progressEnabled) {
        return
    }

    this.progressEnabled = false
    this.tracker.removeListener('change', this.showProgress)
    this.gauge.disable()
}

let trackerConstructors = ['newGroup', 'newItem', 'newStream']

let mixinLog = function (tracker) {
    Object.keys(log).forEach(function (P) {
        if (P[0] === '_') {
            return
        }

        if (trackerConstructors.filter(function (C) {
            return C === P
        }).length) {
            return
        }

        if (tracker[P]) {
            return
        }

        if (typeof log[P] !== 'function') {
            return
        }

        let logFunction = log[P]

        tracker[P] = function () {
            return logFunction.apply(log, arguments)
        }
    })

    if (tracker instanceof Progress.TrackerGroup) {
        trackerConstructors.forEach(function (C) {
            let trackerFunction = tracker[C]

            tracker[C] = function () {
                return mixinLog(trackerFunction.apply(tracker, arguments))
            }
        })
    }
    return tracker
}

trackerConstructors.forEach(function (C) {
    log[C] = function () {
        return mixinLog(this.tracker[C].apply(this.tracker, arguments))
    }
})

log.clearProgress = function (cb) {
    if (!this.progressEnabled) {
        return cb && process.nextTick(cb)
    }

    this.gauge.hide(cb)
}

log.showProgress = function (name, completed) {
    if (!this.progressEnabled) {
        return
    }

    let values = {}

    if (name) {
        values.section = name
    }

    let last = log.record[log.record.length - 1]

    if (last) {
        values.subsection = last.prefix
        let levelDisplay = log.levelDisplay[last.level]
        let logline = this._format(levelDisplay, log.style[last.level])

        if (last.prefix) {
            logline += ' ' + this._format(last.prefix, this.prefixStyle)
        }

        logline += ' ' + last.message.split(/\r?\n/)[0]
        values.logline = logline
    }

    values.completed = completed || this.tracker.completed()
    this.gauge.show(values)
}.bind(log)

log.pause = function () {
    this._paused = true

    if (this.progressEnabled) {
        this.gauge.disable()
    }
}

log.resume = function () {
    if (!this._paused) {
        return
    }

    this._paused = false

    let buffer = this._buffer
    this._buffer = []

    buffer.forEach(function (messageObject) {
        this.emitLog(messageObject)
    }, this)

    if (this.progressEnabled) {
        this.gauge.enable()
    }
}

let id = 0

log._buffer = []
log.record = []
log.maxRecordSize = 10000

log.log = function (level, prefix, message) {
    let levelPriority = this.priorityLevels[level]

    if (levelPriority === undefined) {
        return this.emit('error', new Error(util.format('Undefined log level: %j', level)))
    }

    let argumentsArray = new Array(arguments.length - 2)
    let stack = null

    for (let i = 2; i < arguments.length; i++) {
        let arg = argumentsArray[i - 2] = arguments[i]

        if (typeof arg === 'object' && arg instanceof Error && arg.stack) {
            Object.defineProperty(arg, 'stack', {
                value: stack = arg.stack + '',
                enumerable: true,
                writable: true,
            })
        }
    }

    if (stack) {
        argumentsArray.unshift(stack + '\n')
    }

    message = util.format.apply(util, argumentsArray)

    let messageObject = {
        id: id++,
        level: level,
        prefix: String(prefix || ''),
        message: message,
        messageRaw: argumentsArray,
    }

    this.emit('log', messageObject)
    this.emit('log.' + level, messageObject)

    if (messageObject.prefix) {
        this.emit(messageObject.prefix, messageObject)
    }

    this.record.push(messageObject)
    let maxRecordSize = this.maxRecordSize
    let n = this.record.length - maxRecordSize

    if (n > maxRecordSize / 10) {
        let newSize = Math.floor(maxRecordSize * 0.9)
        this.record = this.record.slice(-1 * newSize)
    }

    this.emitLog(messageObject)
}.bind(log)

log.emitLog = function (messageObject) {
    if (this._paused) {
        this._buffer.push(messageObject)
        return
    }

    if (this.progressEnabled) {
        this.gauge.pulse(messageObject.prefix)
    }

    let levelPriority = this.priorityLevels[messageObject.level]

    if (levelPriority === undefined) {
        return
    }

    if (levelPriority < this.priorityLevels[this.level]) {
        return
    }

    if (levelPriority > 0 && !isFinite(levelPriority)) {
        return
    }

    let levelDisplay = log.levelDisplay[messageObject.level]
    this.clearProgress()

    messageObject.message.split(/\r?\n/).forEach(function (line) {
        let heading = this.heading

        if (heading) {
            this.write(heading, this.headingStyle)
            this.write(' ')
        }

        this.write(levelDisplay, log.style[messageObject.level])
        let prefix = messageObject.prefix || ''

        if (prefix) {
            this.write(' ')
        }

        this.write(prefix, this.prefixStyle)
        this.write(' ' + line + '\n')
    }, this)

    this.showProgress()
}

log._format = function (message, style) {
    if (!stream) {
        return
    }

    let output = ''

    if (this.useColor()) {
        style = style || {}
        let settings = []

        if (style.fg) {
            settings.push(style.fg)
        }

        if (style.bg) {
            settings.push('bg' + style.bg[0].toUpperCase() + style.bg.slice(1))
        }

        if (style.bold) {
            settings.push('bold')
        }

        if (style.underline) {
            settings.push('underline')
        }

        if (style.inverse) {
            settings.push('inverse')
        }

        if (settings.length) {
            output += consoleControl.color(settings)
        }

        if (style.beep) {
            output += consoleControl.beep()
        }
    }

    output += message

    if (this.useColor()) {
        output += consoleControl.color('reset')
    }

    return output
}

log.write = function (message, style) {
    if (!stream) {
        return
    }

    stream.write(this._format(message, style))
}

log.addLevel = function (level, priority, style, levelDisplay) {
    if (levelDisplay == null) {
        levelDisplay = level
    }

    this.priorityLevels[level] = priority
    this.style[level] = style

    if (!this[level]) {
        this[level] = function () {
            let argumentsArray = new Array(arguments.length + 1)
            argumentsArray[0] = level

            for (let i = 0; i < arguments.length; i++) {
                argumentsArray[i + 1] = arguments[i]
            }

            return this.log.apply(this, argumentsArray)
        }.bind(this)
    }
    this.levelDisplay[level] = levelDisplay
}

log.prefixStyle = {fg: 'magenta'}
log.headingStyle = {fg: 'white', bg: 'black'}

log.style = {}
log.priorityLevels = {}
log.levelDisplay = {}
log.addLevel('silly', -Infinity, {inverse: true}, 'sill')
log.addLevel('verbose', 1000, {fg: 'cyan', bg: 'black'}, 'verb')
log.addLevel('info', 2000, {fg: 'green'})
log.addLevel('timing', 2500, {fg: 'green', bg: 'black'})
log.addLevel('http', 3000, {fg: 'green', bg: 'black'})
log.addLevel('notice', 3500, {fg: 'cyan', bg: 'black'})
log.addLevel('warn', 4000, {fg: 'black', bg: 'yellow'}, 'WARN')
log.addLevel('error', 5000, {fg: 'red', bg: 'black'}, 'ERR!')
log.addLevel('silent', Infinity)

log.on('error', function () {})
