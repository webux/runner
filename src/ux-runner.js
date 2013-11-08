/*global $*/

// TODO: waitForJQEvent(eventName)

var module = {},
    runner,
    locals = {},
    events = {
        START: "runner:start",
        STEP_START: "runner:stepStart",
        STEP_UPDATE: "runner:stepUpdate",
        STEP_END: "runner:stepEnd",
        STEP_PAUSE: "runner:stepPause",
        DONE: 'runner:done'
    },
    options = {
        async: true,
        interval: 100,
        defaultTimeout: 1000,
        frame: {
            top: 0,
            left: 0,
            width: "100%",
            height: "100%"
        },
        timeouts: {
            mini: 100,
            short: 1000,
            medium: 10000,
            long: 30000,
            forever: 60000
        }
    },
    states = {
        DORMANT: 'dormant',
        RUNNING: 'running',
        COMPLETE: 'complete'
    },
    types = {
        ROOT: 'root',
        SCENARIO: 'scenario',
        SCENE: 'scene',
        STEP: 'step'
    },
    injector,
    all,
    activeStep,
    intv,
    scenarios = [],
    walkStep = null;

if (!Math.uuid) {
    var c = 0;
    Math.uuid = function uuid() {
        c += 1;
        var str = c.toString(36).toUpperCase();
        while (str.length < 6) {
            str = '0' + str;
        }
        return str;
    };
}

function log(message) {
    if (runner.debug) {
        console.log.apply(console, arguments);
    }
}

function dispatch(event) {
    // if they supply a dispatcher. use theirs. Otherwise, default to jquery.
    if (runner.dispatcher) {
        runner.dispatcher.dispatch.apply(runner.dispatcher, arguments);
    } else {
        runner.dispatch.apply(runner, arguments);
    }
}

function setupValues() {
    options.window = options.window || window;
    options.rootElement = options.rootElement || $(options.window.document);
    injector = runner.getInjector && runner.getInjector() || {invoke: invoke};
    runner.locals.injector = injector;
}

function init() {
    setupValues();
    runner.walking = false;
    runner.exit = false;
    applyInPageMethods();
}

function applyInPageMethods() {
    if (runner.inPageMethods.length) {
        each(runner.inPageMethods, function (method) {
            method.apply(runner.options.window, []);
        });
        runner.inPageMethods.length = 0;
    }
}

function setup() {
    var config = {name: "all", type: types.ROOT, label: "E2E Tests", parent: {
        type: types.ROOT,
        depth: 0,
        next: function () {
            log("All Complete");
            dispatch(events.DONE);
        }
    }};
    all = step(config);
    config.depth = 0;
    activeStep = all;
}

function charPack(char, len) {
    var str = "";
    while (str.length < len) {
        str += char;
    }
    return str;
}

function each(list, method, data) {
    var i = 0, len, result;
    if (list.length) {
        len = list.length;
        while (i < len) {
            result = method(list[i], i, list, data);
            if (result !== undefined) { // if they return a result. Escape.
                return result;
            }
            i += 1;
        }
    } else {
        for (i in list) {
            if (list.hasOwnProperty(i)) {
                result = method(list[i], i, list, data);
                if (result !== undefined) { // if they return a result. Escape.
                    return result;
                }
            }
        }
    }
    return list;
}

// TODO: need to make a warn that will let you know on the output of condition changes.
function step(exports) {
    var steps = [],
        index = 0,
        childStep,
        exit = false,// exit will set to true if it cannot run.
        exitMessage = "",
        targetParentTypes = [types.SCENARIO, types.ROOT];

    if (exports.type === types.ROOT) {
        targetParentTypes = [types.ROOT];
    } else if (exports.type === types.STEP) {
        targetParentTypes = [types.SCENE, types.STEP];
    }
    while (exports.parent && targetParentTypes.indexOf(exports.parent.type) === -1) {
        exports.parent = exports.parent.parent;
    }

    if (!exports.parent && exports.type !== types.ROOT) {
        runner.exit = exports.exit = exit = true;
        exitMessage = "Unable find step parent. Most likely caused by improper organization. Such as adding a find inside a scenario instead of inside a step.";
    }

    function add(step) {
        steps.push(step);
    }

    function run() {
        exports.state = states.RUNNING;
        activeStep = exports;
        exports.startTime = Date.now();
        if (exports.parent) {
            exports.exit = exit = exports.parent.exit;
            exitMessage = "(EXIT: exit inherited.)";
        }
        if (exports.parent && exports.parent.element) {
            exports.element = exports.parent.element;
        }
        dispatch(events.STEP_START, exports);
        log("%sRUN:%s: %s", charPack("\t", exports.depth), exports.type, exports.label);
        finalize();
        return exports;
    }

    function next() {
        if (runner.walking) {
            dispatch(events.STEP_UPDATE, exports);
        }
        childStep = steps[index];
        if (childStep) {
            index += 1;
            childStep.run();
            return;
        }
        complete();
    }

    function complete() {
        if (exports.state !== states.COMPLETE) {
            exports.state = states.COMPLETE;
            log("%sCOMPLETE:%s: %s", charPack("\t", exports.depth), exports.type, exports.label);
            dispatch(events.STEP_END, exports);
        }
        if (exports.onComplete) exports.onComplete();
        exports.parent.next();
    }

    function exec(method) {
        return injector.invoke(method, exports, locals);
    }

    function validate(method) {
        if (method) {
            return !!exec(method);
        }
        return true;
    }

    function finalize() {
        if (exit) {
            exports.label += "(EXIT: " + exitMessage + ")";
            exports.pass = false;
            exports.repeat = 0;
        } else {
            exec(exports.method);
            exports.pass = validate(exports.validate);
        }
        exports.count += 1;
        exports.timedOut = !hasTimeLeft(exports);
        if (exports.repeat > exports.count && !exports.pass && !exports.timedOut) {
            log("%s%s: checking %s", charPack("\t", exports.depth), exports.type, exports.label);
            clearTimeout(intv);
            dispatch(events.STEP_UPDATE, exports);
            // make so that if no timeout it is synchronous
            intv = options.async ? setTimeout(finalize, options.interval) : finalize();
        } else {
            log("%s%s: %s, value:\"%s\" (%s)", charPack("\t", exports.depth), exports.type, exports.label, exports.value, exports.pass ? "pass" : "fail");
            walkStep = exports;
            if (runner.pauseOnFail && !exports.pass) {
                // auto pause when debugging.
                pause();
                dispatch(events.STEP_UPDATE, exports);
            }
            if (runner.walking) {
                dispatch(events.STEP_PAUSE, exports);
                return;
            } else {
                clearTimeout(intv);
                dispatch(events.STEP_UPDATE, exports);
                intv = options.async ? setTimeout(next, options.interval) : next();
            }
        }
    }
    //TODO: Should we keep this or drop it. It is very similar to until. Until is simpler.
    function custom(label, method, validate, timeout) {
        method = method || function () {};
        var s = {
            type: types.STEP,
            parentType: types.STEP,
            repeat: 1,
            label: label || 'CUSTOM',
            value: undefined,
            method: function() {
                s.element = exports.element;
                s.value = s.exec(method);
                return s;
            },
            validate: function() {
                if (typeof validate === 'boolean') {
                    return validate;
                }
                return validate ? s.exec(validate) : true;
            },
            timeout: timeout || options.interval
        };
        createElementStep(s, s.parent);
        return s;
    }

    function until(label, validate, timeout) {
        var s = {
            type: types.STEP,
            parentType: types.STEP,
            repeat: 1,
            label: label || 'UNTIL',
            value: undefined,
            method: function() {
                s.element = exports.element;
                return s;
            },
            validate: function() {
                var result = validate ? s.exec(validate) : true;
                if (hasTimeLeft(s) && !result) {
                    s.repeat += 1;
                }
                return result;
            },
            timeout: timeout || options.interval
        };
        createElementStep(s, s.parent);
        return s;
    }

    function done() {
        exports.isDone = true;
        exports.repeat = 0; // force exit.
    }

    exports.id = Math.uuid();
    exports.state = states.DORMANT;
    exports.type = exports.type || types.STEP;
    exports.label = exports.label || "no label";
    exports.timeout = exports.timeout || options.defaultTimeout;
    exports.method = exports.method || function () {};
    exports.validate = exports.validate || function () {
        return true;
    };
    exports.repeat = exports.repeat || 1;
    exports.count = 0;
    exports.add = add;
    exports.run = run;
    exports.next = next;
    exports.custom = custom; // use to create a custom chain method.
    exports.until = until;
    exports.done = done;
    exports.exec = exec;
    exports.steps = steps; // externalize so this can be tested.
    exports.depth = exports.parent ? exports.parent.depth + 1 : 0;
    return exports;
}

step.DORMANT = 0;
step.RUNNING = 1;
step.COMPLETE = 2;

function create(params) {
    params.type = params.type || types.STEP;
    params.parent = params.parent || activeStep;
    activeStep.add(step(params));
    return params;
}

function createElementStep(params, parent) {
    params.type = types.STEP;
    params.parent = parent || activeStep;
    create(params);
    addJQ(params);
    return params;
}

function scenario(label, method) {
    create({
        type: types.SCENARIO,
        parentType: types.SCENARIO,
        label: label,
        method: method
    });
}

function scene(label, method, validate, timeout) {
    create({
        type: types.SCENE,
        parentType: types.SCENARIO,
        label: label,
        method: method,
        validate: validate,
        timeout: timeout
    });
}

function wait(timeout) {
    timeout = timeout || options.interval;
    create({
        type: types.STEP,
        parentType: types.SCENE,
        label: "wait " + timeout + "ms",
        method: null,
        repeat: 10000,
        validate: function () {
            return !hasTimeLeft(this, true);
        },
        timeout: timeout
    });
}

function waitFor(label, fn, timeout) {
    create({
        type: types.STEP,
        parentType: types.SCENE,
        label: "wait for " + label,
        method: null,
        repeat: 10000,
        validate: fn,
        timeout: timeout
    });
}

function waitForNgEvent(event, timeout) {
    var s = {
        type: types.STEP,
        parentType: types.SCENE,
        label: "wait for \"" + event + "\" event.",
        repeat: 10000,
        scope: null,
        method: function () {
            if (!s.scope) {
                s.element = s.parent.element || options.rootElement;
                s.scope = s.element.scope();
                s.scope.$on(event, function () {
                    s.ngEvent = true;
                });
            }
        },
        validate: function () {
            return !!s.ngEvent;
        },
        timeout: timeout || options.timeouts.short
    };
    create(s);
}

function hasTimeLeft(s, stepBefore) {
    return s.timeout + s.startTime - (stepBefore ? options.interval : 0) > Date.now();
}

function chainMethodPreExec(step, el, name, args) {
    if (name === 'trigger') {
        step.label = 'trigger "' + args[0].toUpperCase() + '"';
    }
}

function jqMethod(target, name, validate) {
    return function () {
        var args = arguments,
            s = {
                label: name.toUpperCase(),
                value: undefined,
                timeout: options.interval,
                method: function () {
                    var el = s.element;
                    if (el) {
                        if (!el[name]) {
                            throw new Error("Method \"" + name + "\" is not supported yet.");
                        }
                        chainMethodPreExec(s, el, name, args);
                        el[name].apply(el, args);
                        if (validate) {
                            s.value = el[name].apply(el, []);
                        }
                    }
                    return s;
                },
                validate: function () {
                    if (!s.element || !s.element.length) {
                        return false;
                    }
                    if (validate && args.length) {
                        return s.value === args[0];
                    }
                    return true;
                }
            };
        createElementStep(s, target);
        return s;
    };
}

function addJQ(target) {
    createJqMethods(target);
    createJqAccessors(target);
    each(runner.elementMethods, addElementMethods, target);
}

function createJqMethods(target) {
    var i = 0, len = runner.jqMethods.length;
    while (i < len) {
        target[runner.jqMethods[i]] = jqMethod(target, runner.jqMethods[i]);
        i += 1;
    }
}

function createJqAccessors(target) {
    var i = 0, len = runner.jqAccessors.length;
    while (i < len) {
        target[runner.jqAccessors[i]] = jqMethod(target, runner.jqAccessors[i], true);
        i += 1;
    }
}

function addElementMethods(stepData, index, list, target) {
    if (typeof stepData === "function") {
        stepData(target);
    } else {
        target[stepData.name] = stepData.method(target);
    }
}

function find(selector, timeout, label) {
    var selectorLabel = (typeof selector === "function" ? "(custom method)" : selector);
    var s = {
        type: types.STEP,
        parentType: types.SCENE,
        repeat: 1e4,
        label: label || 'find: "' + selectorLabel + '"',
        value: undefined,
        method: function() {
            s.value = s.element = options.rootElement.find(typeof selector === "function" ? s.exec(selector) : selector);
            return s;
        },
        validate: function() {
            var result = !!s.value.length;
            s.label = result ? s.label : "could not find" + ' "' + selectorLabel + '"';
            return result;
        },
        timeout: timeout
    };
    createElementStep(s);
    return s;
}

function invoke(fn, scope, locals) {
    var injectables = getInjectables(fn, locals);
    return fn.apply(scope, injectables.args);
}

function getInjectables(fn, locals) {
    var str = fn.toString(), result = {map: {}, args: [], locals: locals}, list,
        params = str.match(/\(.*\)/)[0].match(/([\$\w])+/gm);
    if (params && params.length) {
        each(params, addInjection, result);
    }
    return result;
}

function addInjection(name, index, list, data) {
    data.map[name] = data.locals[name] || window[name];
    data.args.push(data.map[name]);
}

function addScenario(name, scenario) {
    scenarios.push({name: name, scenario: scenario});
    return scenario;
}

function clearScenarios() {
    scenarios.length = 0;
    runner.scenarios = {};
}

function applyConfig(config) {
    runner.options = $.extend(options, config);
}

function getScenarioNames() {
    var ary = [];
    each(scenarios, function (sc) {
        ary.push(sc.name);
    });
    return ary;
}

function getScenario(name) {
    name = name.toLowerCase();
    return each(scenarios, function (sc) {
        if (sc.name.toLowerCase() === name) {
            return sc;
        }
    });
}

function runScenario(scenario) {
    scenario = typeof scenario !== "string" ? scenario : getScenario(scenario);
    create({
        type: types.SCENARIO,
        parentType: types.ROOT,
        label: "SCENARIO: " + scenario.name,
        method: scenario.scenario
    });
}

function runAll() {
    var i = 0, len = scenarios.length;
    while (i < len) {
        runScenario(scenarios[i]);
        i += 1;
    }
}

function run(scenarioName) {
    if (runner.stop) runner.stop();
    init();
    if (runner.onStart) runner.onStart();
    dispatch(events.START);
    log("run");
    setup();
    if (scenarioName) {
        each(arguments, runScenario);
    } else {
        runAll();
    }
    activeStep.run();
}

function walk(scenarioName) {
    run.apply(runner, arguments);
    pause();
}

function forceStep() {
    walkStep.next();
}

function pause() {
    runner.walking = true;
}

function resume() {
    runner.walking = false;
    forceStep();
}

function repeat(method, times) {
    var i = 0, args = exports.util.array.toArray(arguments);
    args.shift();
    args.shift();
    while (i < times) {
        method.apply({}, [i].concat(args));
        i += 1;
    }
}

function repeatUntil(fn, count, parent, addAfter) {
    // create a step to execute the repeatUntil.
    count = count || 0;
    parent = parent || activeStep;
    var doneExecuted = false,
        done = function() {
            doneExecuted = true;
        },
        params = {
            type: types.SCENE,
            parentType: types.SCENARIO,
            label: "repeatUntil",
            parent: parent,
            method: function () {},
            validate: function () {
                // execute the method which may create child steps.
                injector.invoke(fn, exports, $.extend({count: count, done: done}, locals));
                if (doneExecuted) {
                    params.label = "repeatUntil - END";
                }
                return true;
            },
            onComplete: function () {
                if (!doneExecuted) {
                    // until done gets executed. Keep calling.
                    repeatUntil(fn, count + 1, parent, params);
                }
            },
            timeout: options.interval
        };
    params.type = params.type || types.STEP;
    params.parent = params.parent || activeStep;
    if (addAfter) {
        parent.steps.splice(parent.steps.indexOf(addAfter) + 1, 0, step(params));
    } else {
        parent.add(step(params));
    }
    params.done = done;
}

runner = {
    getInjector: null,
    compact: true,
    debug: false,
    config: applyConfig,
    exit: false,
    run: run,
    walk: walk,
    walking: false,
    pauseOnFail: true,
    next: forceStep,
    pause: pause,
    resume: resume,
    addScenario: addScenario,
    clearScenarios: clearScenarios,
    getScenarioNames: getScenarioNames,
    types: types,
    events: events,
    states: states,
    createStep: create,
    createElementStep: createElementStep,
    elementMethods: [],
    scenarios: {}, // external stub for constants.
    locals: locals,
    dispatcher: null,
    each: each,
    repeat: repeat,
    inPageMethods: [],
    jqMethods: ['focus', 'blur', 'click', 'mousedown', 'mouseover', 'mouseup', 'select', 'touchstart', 'touchend', 'trigger'],
    jqAccessors: ['val', 'text', 'html', 'scrollTop']
};
locals.scenario = scenario;
locals.repeatUntil = repeatUntil;
locals.scene = scene;
locals.find = find;
locals.options = options;
locals.wait = wait;
locals.waitFor = waitFor;
locals.waitForNgEvent = waitForNgEvent;

dispatcher(runner);
exports.runner = runner;

$('body').ready(function () {
    if (runner.options && runner.options.autoStart) {
        if (typeof runner.options.autoStart === "function") {
            setupValues();
            runner.options.autoStart.apply(runner, []);
        } else {
            // give it a little time before starting.
            setTimeout(runner.run, 1000);
        }
    }
});
