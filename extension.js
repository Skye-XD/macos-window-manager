/* Three-finger swipe down → show desktop with live preview (GNOME Shell 50, ESM) */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {actionMode} from 'resource:///org/gnome/shell/ui/main.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {SwipeTracker} from 'resource:///org/gnome/shell/ui/swipeTracker.js';
import {lerp} from 'resource:///org/gnome/shell/misc/util.js';
import {MonitorConstraint} from 'resource:///org/gnome/shell/ui/layout.js';

const FINGER_COUNT = 3;
const DRAG_THRESHOLD_PX = 16;
const ACTIVATION_DOWN_PX = 80;
const CANCEL_PROGRESS = 0.15;
const MIN_FINISH_DURATION_MS = 120;
const SWIPE_MULTIPLIER = 1;

// macOS pushes each window off whichever screen edge it already sits nearest,
// at full size and full opacity, and *parks* it there: a sliver stays on
// screen and the window is never minimized. Clicking a sliver pulls them back.
const EASING_MODES = {
    'ease-out-cubic': Clutter.AnimationMode.EASE_OUT_CUBIC,
    'ease-out-quad': Clutter.AnimationMode.EASE_OUT_QUAD,
    'ease-out-expo': Clutter.AnimationMode.EASE_OUT_EXPO,
    'ease-out-back': Clutter.AnimationMode.EASE_OUT_BACK,
    'ease-in-out-cubic': Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
};

/**
 * The values that govern how this feels, read from GSettings at the moment
 * they are used rather than cached, so adjusting one takes effect on the next
 * gesture instead of on the next login.
 */
class Tunables {
    constructor(settings) {
        this._settings = settings;
    }

    get peek() {
        return this._settings.get_int('peek-px');
    }

    get duration() {
        return this._settings.get_int('animation-duration');
    }

    get easing() {
        return EASING_MODES[this._settings.get_string('easing')] ??
            Clutter.AnimationMode.EASE_OUT_CUBIC;
    }

    get showScale() {
        return this._settings.get_double('pinch-show-scale');
    }

    get restoreScale() {
        return this._settings.get_double('pinch-restore-scale');
    }

    get commitProgress() {
        return this._settings.get_double('pinch-commit-progress');
    }

    get gridPadding() {
        return this._settings.get_int('grid-padding-px');
    }
}

// Windows are hidden rather than minimized while parked, so a parked window
// taking focus has to bring them back first. Ignore focus changes for this
// long after parking, since hiding the actors can itself move focus.
const PARK_SETTLE_US = 500000;

// Closing a window hands focus to whatever is next in the stack, which while
// parked is a hidden window. That is incidental, not the user asking for it
// back, so focus goes to the desktop instead for this long after a close.
const CLOSE_FALLBACK_US = 400000;

// Four-finger spread shows the desktop and four-finger pinch brings it back.
// These arrive as TOUCHPAD_PINCH events carrying an absolute scale, which is
// why a SwipeTracker cannot express them.
const PINCH_FINGER_COUNT = 4;

// How far the scale has to leave 1 before the gesture is claimed. Four fingers
// resting on the pad report a scale of 1 and jitter either side of it, and
// claiming there would swallow pinches meant for somebody else.
const PINCH_DEADZONE = 0.02;

// Window types worth spreading. An allow list rather than a deny list, so a
// type nobody thought about is left alone instead of being flung off screen.
const SPREADABLE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

// Emitted by the desktop-icons fork when a click lands on empty desktop.
// DING owns that surface, so the shell never sees the press itself.
const DING_BUS_NAME = 'com.desktop.ding';
const DING_CLICK_SIGNAL = 'desktopclick';

const DesktopState = {
    NORMAL: 0,
    SHOW_DESKTOP: 1,
};

const TouchpadState = {
    NONE: 0,
    PENDING: 1,
    HANDLING: 2,
    IGNORED: 3,
};

function isDesktopMode() {
    return (Shell.ActionMode.NORMAL & actionMode) !== 0 && !Main.overview.visible;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function primarySwipeDistance() {
    const m = Main.layoutManager.primaryMonitor;
    return m?.height ?? 900;
}

function progressToUnit(progress) {
    return clamp(progress, 0, 1);
}

/**
 * Vertical touchpad swipe — only finger motion toward the bottom of the pad.
 */
const TouchpadSwipeDownOnly = GObject.registerClass(
    {
        Signals: {
            begin: {
                param_types: [
                    GObject.TYPE_UINT,
                    GObject.TYPE_DOUBLE,
                    GObject.TYPE_DOUBLE,
                ],
            },
            update: {
                param_types: [
                    GObject.TYPE_UINT,
                    GObject.TYPE_DOUBLE,
                    GObject.TYPE_DOUBLE,
                ],
            },
            end: {param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE]},
        },
    },
    class TouchpadSwipeDownOnly extends GObject.Object {
        constructor(allowedModes) {
            super();
            this._nfingers = [FINGER_COUNT];
            this._allowedModes = allowedModes;
            this._swipeDistance = primarySwipeDistance();
            this._state = TouchpadState.NONE;
            this.enabled = true;

            this._stageHandler = global.stage.connect(
                'captured-event::touchpad',
                this._onEvent.bind(this),
            );
        }

        destroy() {
            if (this._stageHandler) {
                global.stage.disconnect(this._stageHandler);
                this._stageHandler = 0;
            }
        }

        setSwipeDistance(distance) {
            this._swipeDistance = Math.max(distance, 200);
        }

        _reset() {
            this._state = TouchpadState.NONE;
            this._cumulativeX = 0;
            this._cumulativeY = 0;
        }

        _motionDelta(dy) {
            // Signed delta: down on pad increases progress, reversing up decreases it.
            return dy * SWIPE_MULTIPLIER;
        }

        _onEvent(_actor, event) {
            if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
                return Clutter.EVENT_PROPAGATE;

            const phase = event.get_gesture_phase();

            if (phase === Clutter.TouchpadGesturePhase.BEGIN)
                this._reset();

            if (this._state === TouchpadState.IGNORED)
                return Clutter.EVENT_PROPAGATE;

            if (!this.enabled)
                return Clutter.EVENT_PROPAGATE;

            if (
                this._allowedModes !== Shell.ActionMode.ALL &&
                (this._allowedModes & actionMode) === 0
            ) {
                this._state = TouchpadState.IGNORED;
                return Clutter.EVENT_PROPAGATE;
            }

            if (!this._nfingers.includes(event.get_touchpad_gesture_finger_count())) {
                this._state = TouchpadState.IGNORED;
                return Clutter.EVENT_PROPAGATE;
            }

            const time = event.get_time();
            const [x, y] = event.get_coords();
            const [, dy] = event.get_gesture_motion_delta_unaccelerated();

            if (this._state === TouchpadState.NONE) {
                if (dy === 0 && event.get_gesture_motion_delta_unaccelerated()[0] === 0)
                    return Clutter.EVENT_PROPAGATE;
                this._cumulativeX = 0;
                this._cumulativeY = 0;
                this._state = TouchpadState.PENDING;
            }

            if (this._state === TouchpadState.PENDING) {
                const [dx] = event.get_gesture_motion_delta_unaccelerated();
                this._cumulativeX += dx;
                this._cumulativeY += dy;
                const cdx = this._cumulativeX;
                const cdy = this._cumulativeY;

                if (Math.hypot(cdx, cdy) < DRAG_THRESHOLD_PX)
                    return Clutter.EVENT_PROPAGATE;

                if (Math.abs(cdy) <= Math.abs(cdx)) {
                    this._state = TouchpadState.IGNORED;
                    return Clutter.EVENT_PROPAGATE;
                }

                // Start only on downward intent; upward-only swipes go to Overview.
                if (cdy <= 0) {
                    this._state = TouchpadState.IGNORED;
                    return Clutter.EVENT_PROPAGATE;
                }

                this._cumulativeX = 0;
                this._cumulativeY = 0;
                this._state = TouchpadState.HANDLING;
                this.emit('begin', time, x, y);
            }

            if (this._state !== TouchpadState.HANDLING)
                return Clutter.EVENT_PROPAGATE;

            const distance = this._swipeDistance;

            if (
                phase === Clutter.TouchpadGesturePhase.UPDATE ||
                phase === Clutter.TouchpadGesturePhase.BEGIN
            ) {
                this.emit('update', time, this._motionDelta(dy), distance);
                return Clutter.EVENT_STOP;
            }

            if (
                phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL
            ) {
                this.emit('end', time, distance);
                this._reset();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_STOP;
        }
    },
);

/**
 * Four-finger pinch and spread. Clutter reports these with an absolute scale
 * rather than a motion delta, so there is no distance to accumulate: the scale
 * is the whole state.
 *
 * It reports that scale and nothing more. Whether a gesture means "park" or
 * "restore" depends on what is on screen when it starts, which only
 * ShowDesktopGesture knows, so the mapping from scale to progress lives there.
 *
 * `begin` is emitted when the scale first leaves the deadzone rather than on
 * the gesture's own BEGIN phase, since nothing is known about direction until
 * the fingers move. A handler that cannot use the gesture calls `cancel()`
 * from inside `begin` -- signal emission is synchronous, so that decision is
 * settled before the event is disposed of -- and the rest of the gesture is
 * then propagated untouched.
 */
const TouchpadPinch = GObject.registerClass(
    {
        Signals: {
            begin: {param_types: [GObject.TYPE_DOUBLE]},
            update: {param_types: [GObject.TYPE_DOUBLE]},
            end: {param_types: [GObject.TYPE_DOUBLE]},
        },
    },
    class TouchpadPinch extends GObject.Object {
        constructor(tunables) {
            super();
            this._tunables = tunables;
            this.enabled = true;
            this._state = TouchpadState.NONE;
            this._scale = 1;

            this._stageHandler = global.stage.connect(
                'captured-event::touchpad',
                this._onEvent.bind(this),
            );
        }

        destroy() {
            if (this._stageHandler) {
                global.stage.disconnect(this._stageHandler);
                this._stageHandler = 0;
            }
        }

        /**
         * Decline the gesture being offered. Only meaningful from a `begin`
         * handler.
         */
        cancel() {
            this._state = TouchpadState.IGNORED;
        }

        _onEvent(_actor, event) {
            if (event.type() !== Clutter.EventType.TOUCHPAD_PINCH)
                return Clutter.EVENT_PROPAGATE;

            const phase = event.get_gesture_phase();

            if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
                this._state = TouchpadState.NONE;
                this._scale = 1;
            }

            if (this._state === TouchpadState.IGNORED)
                return Clutter.EVENT_PROPAGATE;

            if (!this.enabled)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_touchpad_gesture_finger_count() !== PINCH_FINGER_COUNT) {
                this._state = TouchpadState.IGNORED;
                return Clutter.EVENT_PROPAGATE;
            }

            if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
                this._scale = event.get_gesture_pinch_scale();

                if (this._state === TouchpadState.NONE) {
                    if (Math.abs(this._scale - 1) < PINCH_DEADZONE)
                        return Clutter.EVENT_PROPAGATE;

                    this._state = TouchpadState.HANDLING;
                    this.emit('begin', this._scale);
                    if (this._state !== TouchpadState.HANDLING)
                        return Clutter.EVENT_PROPAGATE;
                }

                this.emit('update', this._scale);
                return Clutter.EVENT_STOP;
            }

            if (
                phase === Clutter.TouchpadGesturePhase.END ||
                phase === Clutter.TouchpadGesturePhase.CANCEL
            ) {
                if (this._state !== TouchpadState.HANDLING)
                    return Clutter.EVENT_PROPAGATE;

                this._state = TouchpadState.NONE;
                this.emit('end', this._scale);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }
    },
);

function createDownSwipeTracker(allowedModes) {
    const swipeTracker = new SwipeTracker(
        global.stage,
        Clutter.Orientation.VERTICAL,
        allowedModes,
        {allowDrag: false, allowScroll: false, phase: Clutter.EventPhase.CAPTURE},
    );

    swipeTracker.allowLongSwipes = false;

    if (swipeTracker._touchpadGesture)
        swipeTracker._touchpadGesture.destroy();

    const touchpad = new TouchpadSwipeDownOnly(allowedModes);
    swipeTracker._touchpadGesture = touchpad;

    touchpad.connect('begin', swipeTracker._beginTouchpadGesture.bind(swipeTracker));
    touchpad.connect('update', swipeTracker._updateTouchpadGesture.bind(swipeTracker));
    touchpad.connect('end', swipeTracker._endTouchpadGesture.bind(swipeTracker));
    swipeTracker.bind_property(
        'enabled',
        touchpad,
        'enabled',
        GObject.BindingFlags.SYNC_CREATE,
    );

    return swipeTracker;
}

/**
 * Scales and slides window clones toward the bottom (overview-like motion).
 */
class MonitorGroup {
    constructor(monitor, tunables) {
        this.monitor = monitor;
        this._tunables = tunables;
        // 'edge' parks windows off the side; 'grid' tiles them to be picked
        // from. The two differ only in where a clone is sent, so everything
        // else -- clones, animation, teardown -- is shared.
        this._layout = 'edge';
        this._container = new Clutter.Actor({visible: false});
        this._container.add_constraint(new MonitorConstraint({index: monitor.index}));
        this._container.set_clip_to_allocation(true);
        Main.layoutManager.uiGroup.insert_child_above(
            this._container,
            global.window_group,
        );
        this._entries = [];
        this._parked = [];
        this._finishing = 0;
        this._onParkedClick = null;
    }

    destroy() {
        this.abort();
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
    }

    setLayout(mode) {
        this._layout = mode;
    }

    /**
     * Tile every entry into the monitor so none overlaps, scaled to fit.
     *
     * Laid out for all entries at once rather than per entry, because a tile's
     * size depends on how many there are.
     */
    _layoutGrid() {
        const pad = this._tunables.gridPadding;
        const n = this._entries.length;
        if (n === 0)
            return;

        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cellW = (this.monitor.width - pad * (cols + 1)) / cols;
        const cellH = (this.monitor.height - pad * (rows + 1)) / rows;

        this._entries.forEach((entry, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            // Never scale a window up: a small window stays its own size
            // rather than being blown up to fill a tile.
            const scale = Math.min(cellW / entry.baseW, cellH / entry.baseH, 1);
            const w = entry.baseW * scale;
            const h = entry.baseH * scale;
            entry.endScale = scale;
            entry.endX = pad + col * (cellW + pad) + (cellW - w) / 2;
            entry.endY = pad + row * (cellH + pad) + (cellH - h) / 2;
        });
    }

    _layoutEntry(entry) {
        const {clone} = entry;
        entry.baseW = clone.width;
        entry.baseH = clone.height;
        entry.startX = clone.x;
        entry.startY = clone.y;
        entry.startScale = 1;
        entry.endScale = 1;

        // The clone carries the whole window actor, including the invisible
        // shadow border, which on a floating window is wide enough to swallow
        // the sliver whole and leave nothing showing. Measure against the
        // visible frame instead.
        const frame = entry.windowActor.meta_window?.get_frame_rect?.();
        const inset = frame ? frame.x - entry.windowActor.x : 0;
        const frameW = frame ? frame.width : entry.baseW;

        // Windows only ever leave sideways -- macOS never sends one off the
        // top or the bottom -- so the side is decided by which half of the
        // monitor the visible frame's centre sits in, and the vertical
        // position is left alone.
        const peek = this._tunables.peek;
        const centre = entry.startX + inset + frameW / 2;

        entry.endY = entry.startY;
        entry.endX = centre < this.monitor.width / 2
            ? peek - inset - frameW
            : this.monitor.width - peek - inset;
    }

    begin(windowActors) {
        this.abort();

        for (const windowActor of windowActors) {
            const clone = new Clutter.Clone({
                source: windowActor,
                x: windowActor.x - this.monitor.x,
                y: windowActor.y - this.monitor.y,
            });
            clone.set_pivot_point(0, 0);
            clone.reactive = true;
            clone.connect('button-press-event', () => {
                this._onParkedClick?.(windowActor.meta_window);
                return Clutter.EVENT_STOP;
            });
            windowActor.hide();
            const entry = {clone, windowActor};
            this._layoutEntry(entry);
            this._entries.push(entry);
            // Window actors arrive bottom to top, so each clone goes on top of
            // the last. Inserting at the bottom instead reversed the stack and
            // the wrong window covered its neighbour for the whole animation.
            this._container.insert_child_above(clone, null);
        }

        if (this._layout === 'grid')
            this._layoutGrid();

        if (this._entries.length > 0)
            this._container.show();
    }

    _applyProgress(progress) {
        const p = progressToUnit(progress);

        for (const entry of this._entries) {
            const {clone, startX, startY, endX, endY, startScale, endScale} = entry;
            clone.remove_all_transitions();
            const scale = lerp(startScale, endScale, p);
            clone.set_pivot_point(0, 0);
            clone.set_scale(scale, scale);
            clone.x = lerp(startX, endX, p);
            clone.y = lerp(startY, endY, p);
        }
    }

    update(progress) {
        if (this._finishing > 0)
            return;
        this._applyProgress(progress);
    }

    // Only ever reached with NORMAL: a parked entry keeps its clone and never
    // gets here. Windows are hidden rather than minimized, so the only thing
    // to undo is the hiding -- plus an unminimize for a window some other path
    // minimized while it was parked.
    _applyWindowState(windowActor, desktopState) {
        const win = windowActor.meta_window;
        Main.wm.skipNextEffect(windowActor);
        if (win?.minimized)
            win.unminimize();
        windowActor.show();
    }

    /**
     * @param entry - the clone and window this animates
     * @param progress - lerp target, 0 for home and 1 for the parked position
     * @param duration - animation length in ms
     * @param windowState - what the window should end up as
     * @param reveal - whether to hand the screen back to the real window here.
     *   end() passes false and reveals every window at once instead: doing it
     *   per window leaves some represented by real actors, which live in the
     *   window group, and others still by clones, which sit above it -- so a
     *   window flashes above one it is really below until the last clone goes.
     * @param onDone - called once this entry has settled
     */
    _finishEntry(entry, progress, duration, windowState, reveal, onDone) {
        const {clone, windowActor} = entry;
        const p = progressToUnit(progress);
        const targetX = lerp(entry.startX, entry.endX, p);
        const targetY = lerp(entry.startY, entry.endY, p);
        const targetScale = lerp(entry.startScale, entry.endScale, p);

        clone.remove_all_transitions();

        const finalize = () => {
            this._finishing -= 1;
            // Parked entries keep their clone: it stands in for the window at
            // the edge, whose actor stays hidden. macOS leaves the windows
            // there rather than minimizing them away.
            if (reveal && windowState !== DesktopState.SHOW_DESKTOP) {
                this._applyWindowState(windowActor, windowState);
                clone.destroy();
            }
            onDone();
        };

        const dur = Math.max(duration, MIN_FINISH_DURATION_MS);
        if (dur <= 0) {
            clone.x = targetX;
            clone.y = targetY;
            clone.set_scale(targetScale, targetScale);
            finalize();
            return;
        }

        this._finishing += 1;
        clone.ease({
            x: targetX,
            y: targetY,
            scale_x: targetScale,
            scale_y: targetScale,
            duration: dur,
            mode: this._tunables.easing,
            onStopped: finalize,
        });
    }

    end(progress, duration, windowState = progress) {
        if (this._entries.length === 0) {
            this._container.hide();
            return;
        }

        const entries = this._entries;
        this._entries = [];
        const parking = windowState === DesktopState.SHOW_DESKTOP;
        let remaining = entries.length;

        const done = () => {
            remaining -= 1;
            if (remaining > 0 || parking)
                return;

            // Every window comes back in the same frame, for the reason given
            // on _finishEntry's reveal parameter.
            for (const entry of entries) {
                this._applyWindowState(entry.windowActor, windowState);
                entry.clone.destroy();
            }
            this._container.hide();
        };

        for (const entry of entries)
            this._finishEntry(entry, progress, duration, windowState, false, done);

        if (parking)
            this._parked = entries;
    }

    /**
     * Slide the parked clones back to where their windows really are, then
     * hand the screen back to the real actors.
     *
     * @param {number} duration animation length in ms
     * @returns {boolean} whether anything was parked
     */
    unpark(duration) {
        if (!this.resume())
            return false;

        this.end(0, duration, DesktopState.NORMAL);
        return true;
    }

    /**
     * Make the parked clones live again, so update() drives them. The caller
     * owns them from there and must reach end(), which either hands the screen
     * back to the real windows or parks them again.
     *
     * @returns {boolean} whether anything was parked
     */
    resume() {
        if (this._parked.length === 0)
            return false;

        this._entries = this._parked;
        this._parked = [];
        // The park animation may still be running. Taking the clones over
        // means driving them by hand from here, and update() refuses while a
        // finish is in flight. Dropping the transitions runs each onStopped,
        // which is why _finishing is zeroed after rather than before.
        for (const {clone} of this._entries)
            clone.remove_all_transitions();
        this._finishing = 0;
        return true;
    }

    /**
     * Bring one parked window back, leaving the rest where they are.
     *
     * @param {Meta.Window} win the window to unpark
     * @param {number} duration animation length in ms
     * @returns {boolean} whether that window was parked here
     */
    unparkWindow(win, duration) {
        const index = this._parked.findIndex(
            entry => entry.windowActor.meta_window === win);
        if (index < 0)
            return false;

        const [entry] = this._parked.splice(index, 1);
        this._finishEntry(entry, 0, duration, DesktopState.NORMAL, true, () => {
            if (this._parked.length === 0 && this._entries.length === 0)
                this._container.hide();
        });
        return true;
    }

    hasParked() {
        return this._parked.length > 0;
    }

    /**
     * Bring one parked clone to the front, so a window picked from the spread
     * travels back over its neighbours instead of under them.
     *
     * @param {Meta.Window} win the window whose clone to raise
     * @returns {boolean} whether that window is parked here
     */
    raiseCloneFor(win) {
        const entry = this._parked.find(
            e => e.windowActor.meta_window === win);
        if (!entry)
            return false;
        this._container.set_child_above_sibling(entry.clone, null);
        return true;
    }

    /**
     * Restore the window a parked clone stands for, when its sliver is clicked.
     *
     * @param {Function} onClick called when any parked clone is clicked
     */
    setParkedClickHandler(onClick) {
        this._onParkedClick = onClick;
    }

    abort() {
        for (const {clone, windowActor} of [...this._entries, ...this._parked]) {
            clone.remove_all_transitions();
            clone.destroy();
            windowActor.show();
        }
        this._entries = [];
        this._parked = [];
        this._finishing = 0;
        this._container.hide();
    }
}

class ShowDesktopGesture {
    constructor(settings) {
        this._settings = settings;
        this._tunables = new Tunables(settings);
        // null, 'desktop' or 'mission'. The two modes share every actor and
        // differ only in where clones are sent and what a click on one means.
        this._mode = null;
        this._showingDesktop = false;
        this._minimizingWindows = [];
        this._monitorGroups = [];
        this._parkedAt = 0;
        this._windowClosedAt = 0;
        this._displayHandlers = [];
        this._wmHandlers = [];
        this._gestureActive = false;
        // 'park' or 'restore' while a pinch is in flight. Settled once at the
        // start of the gesture rather than re-read per frame, so releasing
        // does the opposite of what the gesture was doing whatever the windows
        // happen to be in the middle of.
        this._gestureDirection = null;
        this._restoreSwipeDown = 0;
        this._restoreHandlers = [];
        this._swipeDistance = primarySwipeDistance();

        this._swipeTracker = createDownSwipeTracker(Shell.ActionMode.NORMAL);
        this._touchpad = this._swipeTracker._touchpadGesture;

        this._handlers = [
            this._swipeTracker.connect('begin', this._onSwipeBegin.bind(this)),
            this._swipeTracker.connect('update', this._onSwipeUpdate.bind(this)),
            this._swipeTracker.connect('end', this._onSwipeEnd.bind(this)),
        ];

        for (const monitor of Main.layoutManager.monitors)
            this._monitorGroups.push(new MonitorGroup(monitor, this._tunables));

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._rebuildMonitorGroups();
        });

        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._leaveShowDesktop();
        });
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            if (this._gestureActive)
                this._cancelActiveGesture(true);
        });

        this._pinch = new TouchpadPinch(this._tunables);
        this._pinchHandlers = [
            this._pinch.connect('begin', this._onPinchBegin.bind(this)),
            this._pinch.connect('update', this._onPinchUpdate.bind(this)),
            this._pinch.connect('end', this._onPinchEnd.bind(this)),
        ];

        // DING draws over the shell's background actor, so a click on empty
        // desktop never reaches the shell. The desktop-icons fork knows the
        // click missed every icon and says so on the bus.
        this._dingClickId = Gio.DBus.session.signal_subscribe(
            DING_BUS_NAME,
            DING_BUS_NAME,
            DING_CLICK_SIGNAL,
            null,
            null,
            Gio.DBusSignalFlags.NONE,
            () => this.toggle(),
        );

        for (const group of this._monitorGroups)
            group.setParkedClickHandler(win => this._onCloneClicked(win));

        Main.wm.addKeybinding('mission-control-toggle', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this.toggleMissionControl());

        // The same toggle the gestures and DING's desktop click reach, so the
        // keyboard is one more way in rather than a second code path.
        Main.wm.addKeybinding('show-desktop-toggle', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this.toggle());

        this._stageKeyId = global.stage.connect('captured-event::key', (_actor, event) => {
            if (this._mode !== 'mission' ||
                event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.hideMissionControl(null);
            return Clutter.EVENT_STOP;
        });

        // A parked window's actor is hidden, so it must not be left focused
        // and invisible -- but only the window actually being asked for comes
        // back, never the whole set. New windows are left alone entirely, or
        // opening a folder from the desktop would drag everything back.
        this._displayHandlers = [
            global.display.connect('notify::focus-window',
                this._onFocusWindow.bind(this)),
        ];

        this._wmHandlers = [
            global.window_manager.connect('destroy', () => {
                this._windowClosedAt = GLib.get_monotonic_time();
            }),
        ];

        this._restoreHandlers = [
            this._touchpad.connect('begin', () => {
                if (this._showingDesktop && !this._gestureActive)
                    this._restoreSwipeDown = 0;
            }),
            this._touchpad.connect('update', (_t, _time, dy, _dist) => {
                if (!this._showingDesktop || this._gestureActive)
                    return;
                this._restoreSwipeDown += dy > 0 ? dy : 0;
            }),
            this._touchpad.connect('end', this._onTouchpadEndForRestore.bind(this)),
        ];
    }

    _rebuildMonitorGroups() {
        if (this._gestureActive)
            this._cancelActiveGesture(false);
        for (const g of this._monitorGroups)
            g.destroy();
        this._monitorGroups = [];
        for (const monitor of Main.layoutManager.monitors) {
            const group = new MonitorGroup(monitor, this._tunables);
            group.setParkedClickHandler(win => this._onCloneClicked(win));
            this._monitorGroups.push(group);
        }
    }

    destroy() {
        this.resetShowDesktop();
        Main.wm.removeKeybinding('mission-control-toggle');
        Main.wm.removeKeybinding('show-desktop-toggle');
        if (this._stageKeyId) {
            global.stage.disconnect(this._stageKeyId);
            this._stageKeyId = 0;
        }
        for (const id of this._displayHandlers)
            global.display.disconnect(id);
        this._displayHandlers = [];
        for (const id of this._wmHandlers)
            global.window_manager.disconnect(id);
        this._wmHandlers = [];
        if (this._dingClickId) {
            Gio.DBus.session.signal_unsubscribe(this._dingClickId);
            this._dingClickId = 0;
        }
        for (const id of this._pinchHandlers)
            this._pinch.disconnect(id);
        this._pinchHandlers = [];
        this._pinch.destroy();
        this._pinch = null;
        for (const id of this._restoreHandlers)
            this._touchpad.disconnect(id);
        this._restoreHandlers = [];
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }
        for (const id of this._handlers)
            this._swipeTracker.disconnect(id);
        this._handlers = [];
        this._swipeTracker.destroy();
        for (const g of this._monitorGroups)
            g.destroy();
        this._monitorGroups = [];
    }

    _collectWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.get_window_actors()
            .filter(a => a.visible)
            .map(a => a.meta_window)
            .filter(win =>
                win &&
                SPREADABLE_TYPES.includes(win.get_window_type()) &&
                !win.minimized &&
                (win.is_always_on_all_workspaces() ||
                    win.get_workspace() === workspace),
            );
    }

    _cancelActiveGesture(animate) {
        if (!this._gestureActive)
            return;

        this._gestureActive = false;
        this._gestureDirection = null;
        if (animate) {
            for (const group of this._monitorGroups)
                group.end(DesktopState.NORMAL, MIN_FINISH_DURATION_MS);
        } else {
            for (const group of this._monitorGroups)
                group.abort();
        }
        // A cancelled pinch may have been dragging parked windows home, so the
        // desktop is no longer being shown -- the swipe never starts while it
        // is, which is why this used to be just the window list.
        this._settleAfterGesture(DesktopState.NORMAL);
    }

    _onTouchpadEndForRestore() {
        if (!this._showingDesktop || this._gestureActive)
            return;
        if (this._restoreSwipeDown >= ACTIVATION_DOWN_PX)
            this._restoreAll();
        this._restoreSwipeDown = 0;
    }

    _onSwipeBegin(tracker, _monitor) {
        if (!isDesktopMode() || this._showingDesktop) {
            this._gestureActive = false;
            return;
        }

        this._minimizingWindows = this._collectWindows();
        if (this._minimizingWindows.length === 0) {
            this._gestureActive = false;
            return;
        }

        this._swipeDistance = primarySwipeDistance();
        this._touchpad.setSwipeDistance(this._swipeDistance);

        tracker.confirmSwipe(
            this._swipeDistance,
            [DesktopState.NORMAL, DesktopState.SHOW_DESKTOP],
            DesktopState.NORMAL,
            CANCEL_PROGRESS,
        );

        let any = false;
        for (const group of this._monitorGroups) {
            const actors = this._minimizingWindows
                .map(w => w.get_compositor_private())
                .filter(a =>
                    a instanceof Meta.WindowActor &&
                    a.meta_window?.get_monitor() === group.monitor.index,
                );
            if (actors.length > 0) {
                group.begin(actors);
                any = true;
            }
        }

        if (!any) {
            this._gestureActive = false;
            this._minimizingWindows = [];
            return;
        }

        this._gestureActive = true;
    }

    _onSwipeUpdate(_tracker, progress) {
        if (!this._gestureActive)
            return;
        const p = progressToUnit(progress);
        for (const group of this._monitorGroups)
            group.update(p);
    }

    _onSwipeEnd(_tracker, duration, endProgress) {
        if (!this._gestureActive) {
            this._restoreSwipeDown = 0;
            return;
        }

        this._gestureActive = false;
        this._gestureDirection = null;
        const target =
            endProgress >= 0.5 ? DesktopState.SHOW_DESKTOP : DesktopState.NORMAL;

        for (const group of this._monitorGroups)
            group.end(target, duration);

        this._settleAfterGesture(target);
    }

    /**
     * A pinch means "park" or "restore" depending on what is on screen when it
     * starts. Both directions run the same begin/update/end path the swipe
     * uses, so the only thing decided here is which way round it goes and
     * where the clones come from.
     */
    _onPinchBegin(_pinch, scale) {
        if (this._gestureActive || !isDesktopMode()) {
            this._pinch.cancel();
            return;
        }

        // Which way the fingers went decides whether there is anything to do,
        // before any clone is made: spreading parks, pinching restores, and
        // the opposite of whatever is on screen is not a gesture at all.
        // Without this an inward pinch on a bare desktop would clone every
        // window and hide the originals only to reveal them again at rest.
        if (this._showingDesktop !== (scale < 1)) {
            this._pinch.cancel();
            return;
        }

        if (this._showingDesktop) {
            let any = false;
            for (const group of this._monitorGroups) {
                if (group.resume())
                    any = true;
            }

            // Showing the desktop with nothing parked means an older path
            // minimized the windows, or a monitor change threw the clones
            // away. There is nothing to drag.
            if (!any) {
                this._pinch.cancel();
                return;
            }

            this._gestureDirection = 'restore';
            this._gestureActive = true;
            return;
        }

        const wins = this._collectWindows();
        const groups = this._groupActorsByMonitor(wins);
        if (groups.length === 0) {
            this._pinch.cancel();
            return;
        }

        this._minimizingWindows = wins;
        for (const {group, actors} of groups) {
            group.setLayout('edge');
            group.begin(actors);
        }

        this._gestureDirection = 'park';
        this._gestureActive = true;
    }

    /**
     * Scale to progress, where 0 is home and 1 is parked. Spreading runs from
     * 1 to showScale and pinching from 1 to restoreScale, so each direction is
     * normalised against its own tunable and the gesture completes exactly
     * where the old threshold used to fire. Both keys keep their meaning:
     * "how far the fingers travel", rather than "where it triggers".
     *
     * @param {number} scale the gesture's absolute scale
     * @returns {number} progress in 0..1
     */
    _pinchProgress(scale) {
        if (this._gestureDirection === 'restore') {
            const span = 1 - this._tunables.restoreScale;
            return span > 0 ? clamp(1 - (1 - scale) / span, 0, 1) : 1;
        }

        const span = this._tunables.showScale - 1;
        return span > 0 ? clamp((scale - 1) / span, 0, 1) : 1;
    }

    /**
     * How far the gesture has come from where it started, so one rule covers
     * both directions: parking counts up from 0, restoring counts down from 1.
     *
     * @param {number} progress 0 for home, 1 for parked
     * @returns {number} distance travelled, in 0..1
     */
    _travelled(progress) {
        return this._gestureDirection === 'restore' ? 1 - progress : progress;
    }

    _onPinchUpdate(_pinch, scale) {
        if (!this._gestureActive)
            return;

        const p = this._pinchProgress(scale);
        for (const group of this._monitorGroups)
            group.update(p);
    }

    _onPinchEnd(_pinch, scale) {
        if (!this._gestureActive)
            return;

        const parking = this._gestureDirection !== 'restore';
        const progress = this._pinchProgress(scale);
        const travelled = this._travelled(progress);
        // Not the midpoint, and deliberately not read off the travel keys:
        // widening those to slow the motion down was also moving the point of
        // no return further away, so a comfortable spread stopped completing.
        const committed = travelled >= this._tunables.commitProgress;

        let target;
        if (parking)
            target = committed ? DesktopState.SHOW_DESKTOP : DesktopState.NORMAL;
        else
            target = committed ? DesktopState.NORMAL : DesktopState.SHOW_DESKTOP;
        // Only the distance still to travel is animated, so letting go a hair
        // from either end takes the minimum finish rather than the full
        // duration. _finishEntry floors it at MIN_FINISH_DURATION_MS.
        const dur = Math.round(
            this._tunables.duration * Math.abs(target - progress));

        this._gestureActive = false;
        this._gestureDirection = null;

        for (const group of this._monitorGroups)
            group.end(target, dur);

        this._settleAfterGesture(target);
    }

    /**
     * Bring the bookkeeping in line with where a gesture actually ended.
     * Shared by the swipe, the pinch and a gesture cancelled in flight, since
     * all three can finish on either side.
     *
     * @param {number} target the DesktopState the groups were sent to
     */
    _settleAfterGesture(target) {
        if (target === DesktopState.SHOW_DESKTOP) {
            this._showingDesktop = true;
            // Left alone if a mode is already set: a pinch that starts on a
            // Mission Control spread and is released short of home re-parks
            // into the grid, and is still Mission Control.
            this._mode ??= 'desktop';
            this._parkedAt = GLib.get_monotonic_time();
            return;
        }

        this._showingDesktop = false;
        // Every dismissal leaves the groups in the parking layout, as
        // restoreDesktop does, so the next gesture is not laid out as a grid.
        this._mode = null;
        for (const group of this._monitorGroups)
            group.setLayout('edge');
        this._minimizingWindows = [];
    }

    _groupActorsByMonitor(wins) {
        const groups = [];
        for (const group of this._monitorGroups) {
            const actors = wins
                .map(w => w.get_compositor_private())
                .filter(a =>
                    a instanceof Meta.WindowActor &&
                    a.meta_window?.get_monitor() === group.monitor.index,
                );
            if (actors.length > 0)
                groups.push({group, actors});
        }
        return groups;
    }

    showDesktop(duration = null) {
        if (this._showingDesktop || this._gestureActive || !isDesktopMode())
            return;

        const wins = this._collectWindows();
        if (wins.length === 0)
            return;

        const groups = this._groupActorsByMonitor(wins);
        if (groups.length === 0)
            return;

        const dur = duration ?? this._tunables.duration;
        this._minimizingWindows = wins;
        for (const {group, actors} of groups) {
            group.setLayout('edge');
            group.begin(actors);
            group.end(DesktopState.SHOW_DESKTOP, dur);
        }
        this._mode = 'desktop';
        this._showingDesktop = true;
        this._parkedAt = GLib.get_monotonic_time();
    }

    restoreDesktop(duration = null) {
        if (!this._showingDesktop || this._gestureActive)
            return;

        const wins = this._minimizingWindows;
        this._minimizingWindows = [];
        this._showingDesktop = false;
        // Every dismissal funnels through here -- gesture, sliver click,
        // desktop click, Escape -- so the mode is cleared here rather than in
        // each caller, and the groups go back to the parking layout.
        this._mode = null;
        for (const group of this._monitorGroups)
            group.setLayout('edge');

        const dur = duration ?? this._tunables.duration;
        let unparked = false;
        for (const group of this._monitorGroups) {
            if (group.unpark(dur))
                unparked = true;
        }

        // Nothing was parked -- windows minimized by an older code path, or a
        // monitor change threw the clones away. Put them back directly.
        if (!unparked) {
            for (const win of wins)
                this._restoreWindow(win);
        }
    }

    _onFocusWindow() {
        if (!this._showingDesktop)
            return;

        // Hiding the actors can move focus by itself.
        if (GLib.get_monotonic_time() - this._parkedAt <= PARK_SETTLE_US)
            return;

        const focused = global.display.focus_window;
        if (!focused || !this._minimizingWindows.includes(focused))
            return;

        // Focus landing on a parked window right after a close is the stack
        // falling through, not the user asking for that window. Hand focus to
        // the desktop and leave everything parked, the way macOS does.
        if (GLib.get_monotonic_time() - this._windowClosedAt < CLOSE_FALLBACK_US) {
            this._focusDesktop();
            return;
        }

        this.unparkWindow(focused);
    }

    _focusDesktop() {
        const desktop = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(win => win?.get_window_type() === Meta.WindowType.DESKTOP);
        desktop?.activate(global.get_current_time());
    }

    /**
     * Bring a single window back and leave the rest parked -- what macOS does
     * when a folder opens in a window that already exists.
     *
     * @param {Meta.Window} win the window to unpark
     */
    unparkWindow(win) {
        const duration = this._tunables.duration;
        let unparked = false;
        for (const group of this._monitorGroups) {
            if (group.unparkWindow(win, duration))
                unparked = true;
        }

        if (!unparked)
            return;

        this._minimizingWindows =
            this._minimizingWindows.filter(parked => parked !== win);

        if (!this._monitorGroups.some(group => group.hasParked())) {
            this._showingDesktop = false;
            this._minimizingWindows = [];
            this._mode = null;
        }
    }

    /**
     * Spread every window of this workspace out to be picked from.
     */
    showMissionControl(duration = null) {
        if (this._showingDesktop || this._gestureActive || !isDesktopMode())
            return;

        const wins = this._collectWindows();
        if (wins.length === 0)
            return;

        const groups = this._groupActorsByMonitor(wins);
        if (groups.length === 0)
            return;

        const dur = duration ?? this._tunables.duration;
        this._minimizingWindows = wins;
        for (const {group, actors} of groups) {
            group.setLayout('grid');
            group.begin(actors);
            group.end(DesktopState.SHOW_DESKTOP, dur);
        }
        this._mode = 'mission';
        this._showingDesktop = true;
        this._parkedAt = GLib.get_monotonic_time();
    }

    /**
     * Put the windows back. Activating one is what picking it means; passing
     * nothing is a cancel.
     *
     * @param {Meta.Window|null} win the window to raise, if any
     */
    hideMissionControl(win) {
        if (this._mode !== 'mission')
            return;

        this._mode = null;

        // Raise before restoring: the clones are stacked in window order, so a
        // picked window would otherwise travel home underneath its neighbours.
        if (win) {
            for (const group of this._monitorGroups)
                group.raiseCloneFor(win);

            // Raise and focus now, while every window actor is still hidden.
            // Raising fixes the stacking before the reveal, so a window picked
            // from the bottom does not arrive underneath its neighbours.
            //
            // activate() both raises and focuses, and doing it here rather
            // than after the animation keeps the whole pick one ordered
            // sequence instead of an animation racing a timer.
            win.activate(global.get_current_time());
        }

        this.restoreDesktop(this._tunables.duration);
    }

    toggleMissionControl() {
        if (this._mode === 'mission')
            this.hideMissionControl(null);
        else
            this.showMissionControl();
    }

    _onCloneClicked(win) {
        if (this._mode === 'mission')
            this.hideMissionControl(win);
        else
            this.restoreDesktop();
    }

    toggle() {
        if (this._gestureActive)
            return;
        if (this._showingDesktop)
            this.restoreDesktop();
        else
            this.showDesktop();
    }

    _restoreWindow(win) {
        if (!win || win.get_window_type() === Meta.WindowType.DESKTOP)
            return;

        const actor = win.get_compositor_private();
        if (actor) {
            Main.wm.skipNextEffect(actor);
            actor.show();
        }
        if (win.minimized)
            win.unminimize();
    }

    _restoreAll() {
        this.restoreDesktop(MIN_FINISH_DURATION_MS);
    }

    _leaveShowDesktop() {
        this._cancelActiveGesture(true);
        if (this._showingDesktop)
            this._restoreAll();
    }

    resetShowDesktop() {
        this._leaveShowDesktop();
        this._minimizingWindows = [];
    }
}

export default class ThreeFingerShowDesktopExtension extends Extension {
    enable() {
        this._gesture = new ShowDesktopGesture(this.getSettings());
    }

    disable() {
        this._gesture?.resetShowDesktop();
        this._gesture?.destroy();
        this._gesture = null;
    }
}
