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

        let func = log[P]
        tracker[P] = function () {
            return func.apply(log, arguments)
        }
    })

    if (tracker instanceof Progress.TrackerGroup) {
        trackerConstructors.forEach(function (C) {
            let func = tracker[C]
            tracker[C] = function () {
                return mixinLog(func.apply(tracker, arguments))
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
        let disp = log.disp[last.level]
        let logline = this._format(disp, log.style[last.level])

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

    let b = this._buffer
    this._buffer = []

    b.forEach(function (m) {
        this.emitLog(m)
    }, this)

    if (this.progressEnabled) {
        this.gauge.enable()
    }
}

log._buffer = []

let id = 0
log.record = []
log.maxRecordSize = 10000

log.log = function (lvl, prefix, message) {
    let l = this.levels[lvl]

    if (l === undefined) {
        return this.emit('error', new Error(util.format(
            'Undefined log level: %j', lvl)))
    }

    let a = new Array(arguments.length - 2)
    let stack = null
    for (let i = 2; i < arguments.length; i++) {
        let arg = a[i - 2] = arguments[i]

        if (typeof arg === 'object' && arg instanceof Error && arg.stack) {
            Object.defineProperty(arg, 'stack', {
                value: stack = arg.stack + '',
                enumerable: true,
                writable: true,
            })
        }
    }

    if (stack) {
        a.unshift(stack + '\n')
    }
    message = util.format.apply(util, a)

    let m = {
        id: id++,
        level: lvl,
        prefix: String(prefix || ''),
        message: message,
        messageRaw: a,
    }

    this.emit('log', m)
    this.emit('log.' + lvl, m)

    if (m.prefix) {
        this.emit(m.prefix, m)
    }

    this.record.push(m)
    let mrs = this.maxRecordSize
    let n = this.record.length - mrs

    if (n > mrs / 10) {
        let newSize = Math.floor(mrs * 0.9)
        this.record = this.record.slice(-1 * newSize)
    }

    this.emitLog(m)
}.bind(log)

log.emitLog = function (m) {
    if (this._paused) {
        this._buffer.push(m)
        return
    }

    if (this.progressEnabled) {
        this.gauge.pulse(m.prefix)
    }

    let l = this.levels[m.level]

    if (l === undefined) {
        return
    }

    if (l < this.levels[this.level]) {
        return
    }

    if (l > 0 && !isFinite(l)) {
        return
    }

    let disp = log.disp[m.level]
    this.clearProgress()

    m.message.split(/\r?\n/).forEach(function (line) {
        let heading = this.heading
        if (heading) {
            this.write(heading, this.headingStyle)
            this.write(' ')
        }
        this.write(disp, log.style[m.level])
        let p = m.prefix || ''
        if (p) {
            this.write(' ')
        }

        this.write(p, this.prefixStyle)
        this.write(' ' + line + '\n')
    }, this)

    this.showProgress()
}

log._format = function (msg, style) {
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
    output += msg

    if (this.useColor()) {
        output += consoleControl.color('reset')
    }

    return output
}

log.write = function (msg, style) {
    if (!stream) {
        return
    }

    stream.write(this._format(msg, style))
}

log.addLevel = function (lvl, n, style, disp) {
    if (disp == null) {
        disp = lvl
    }

    this.levels[lvl] = n
    this.style[lvl] = style

    if (!this[lvl]) {
        this[lvl] = function () {
            let a = new Array(arguments.length + 1)
            a[0] = lvl
            for (let i = 0; i < arguments.length; i++) {
                a[i + 1] = arguments[i]
            }

            return this.log.apply(this, a)
        }.bind(this)
    }
    this.disp[lvl] = disp
}

log.prefixStyle = {fg: 'magenta'}
log.headingStyle = {fg: 'white', bg: 'black'}

log.style = {}
log.levels = {}
log.disp = {}
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
