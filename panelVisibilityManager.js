/**
 * This file is part of Hide Top Bar
 *
 * Copyright 2020 Thomas Vogt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';
const [major] = Config.PACKAGE_VERSION.split('.');
const shellVersion = Number.parseInt(major);

import * as Convenience from './convenience.js';
import * as Intellihide from './intellihide.js';
import * as DesktopIconsIntegration from './desktopIconsIntegration.js';
const DEBUG = Convenience.DEBUG;

const MessageTray = Main.messageTray;
const PanelBox = Main.layoutManager.panelBox;
const ShellActionMode = (
    Shell.ActionMode ? Shell.ActionMode : Shell.KeyBindingMode
);
const _searchEntryBin = Main.overview._overview._controls._searchEntryBin;

export class PanelVisibilityManager {

    constructor(settings, monitorIndex) {
        this._monitorIndex = monitorIndex;
        this._base_y = PanelBox.y;
        this._settings = settings;
        this._preventHide = false;
        this._showInOverview = true;
        this._intellihideBlock = false;
        this._staticBox = new Clutter.ActorBox();
        this._animationActive = false;
        this._shortcutTimeout = null;

        this._seat = Clutter.get_default_backend().get_default_seat();
        this._inTabletMode = this._seat.touch_mode;
        this._tabletModeSignal = this._seat.connect(
            'notify::touch-mode',
            this._onTabletModeChanged.bind(this)
        );
        this._strutsReserved = false;
        this._inTabletOverlay = false;
        this._tabletOverlayReady = false;
        this._tabletMenuEvent = null;
        this._tabletTouchSignalId = null;
        this._tabletOutsideSignalId = null;
        this._tabletAutoHideId = null;

        this._desktopIconsUsableArea = (
            new DesktopIconsIntegration.DesktopIconsUsableAreaClass()
        );
        this._setAffectsStruts(false);

        // We lost the original notification's position because of
        // PanelBox->affectsStruts = false and now it appears beneath the
        // top bar, fix it
        this._oldEase = MessageTray._bannerBin.ease;
        MessageTray._bannerBin.ease = (
            function(params) {
                if (params.hasOwnProperty("y") && PanelBox.y >= 0) {
                    params.y += PanelBox.height;
                }
                this._oldEase.apply(MessageTray._bannerBin, arguments);
            }
        ).bind(this);

        this._pointerWatcher = PointerWatcher.getPointerWatcher();
        this._pointerListener = null;

        // Load settings
        this._bindSettingsChanges();
        this._updateSettingsMouseSensitive();
        this._updateSettingsShowInOverview();
        this._intellihide = new Intellihide.Intellihide(
            this._settings, this._monitorIndex,
        );

        this._updateHotCorner(false);
        this._updateStaticBox();
        this._bindTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 100, this._bindUIChanges.bind(this),
        );
    }

    hide(animationTime, trigger) {
        DEBUG("hide(" + trigger + ")");
        if(this._preventHide) return;
        if(this._inTabletMode
           && this._settings.get_boolean('show-in-tablet-mode')) return;

        let anchor_y = PanelBox.get_pivot_point()[1],
            delta_y = -PanelBox.height;
        if(anchor_y < 0) delta_y = -delta_y;
        let mouse = global.get_pointer();
        if(trigger == "mouse-left" && this._isHovering(...mouse)) return;

        if(this._pointerListener) {
            this._pointerWatcher._removeWatch(this._pointerListener);
            this._pointerListener = null;
        }

        if(this._animationActive) {
            PanelBox.remove_all_transitions();
            this._animationActive = false;
        }

        this._animationActive = true;
        PanelBox.ease({
            y: this._base_y + delta_y,
            duration: animationTime * 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._animationActive = false;
                if (!this._settings.get_boolean('keep-round-corners')) {
                    PanelBox.hide();
                }
                this._updateHotCorner(true);
            }
        });
    }

    show(animationTime, trigger) {
        DEBUG("show(" + trigger + ")");
        if(trigger == "mouse-enter"
           && this._settings.get_boolean('mouse-triggers-overview')) {
            Main.overview.show();
        }

        if(this._animationActive) {
            PanelBox.remove_all_transitions();
            this._animationActive = false;
        }

        this._updateHotCorner(false);
        PanelBox.show();
        if(trigger == "destroy"
           || (
               trigger == "showing-overview"
               && global.get_pointer()[1] < PanelBox.height
               && this._settings.get_boolean('hot-corner')
              )
          ) {
            PanelBox.y = this._base_y;
        } else {
            this._animationActive = true;
            PanelBox.ease({
                y: this._base_y,
                duration: animationTime * 1000,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._animationActive = false;
                    this._updateStaticBox();

                    if (this._inTabletOverlay) return;

                    const mouse = global.get_pointer();

                    if(!this._isHovering(...mouse))
                    {
                        // The cursor has already left the panel, so we can
                        // start hiding the panel immediately.
                        this._handleMenus();
                    }
                    else if(!this._pointerListener)
                    {
                        // The cursor is still on the panel. Start watching the
                        // pointer so we know when it leaves the panel.
                        this._pointerListener =
                            this._pointerWatcher.addWatch
                                (10, this._handlePointer.bind(this));
                    }
                }
            });
        }
    }

    _isHovering(x, y) {
        return (    y >= this._staticBox.y1 &&
                    y < this._staticBox.y2 &&
                    x >= this._staticBox.x1 &&
                    x < this._staticBox.x2 );
    }

    _handlePointer(x, y) {
        if(!this._animationActive && !this._isHovering(x, y)) {
            this._handleMenus();
        }
    }

    _handleMenus() {
        if(!Main.overview.visible) {
            let blocker = Main.panel.menuManager.activeMenu;
            if(blocker == null) {
                this.hide(
                    this._settings.get_double('animation-time-autohide'),
                    "mouse-left"
                );
            } else {
                this._blockerMenu = blocker;
                this._menuEvent = this._blockerMenu.connect(
                    'open-state-changed',
                    (menu, open) => {
                        if(!open && this._blockerMenu !== null) {
                            this._blockerMenu.disconnect(this._menuEvent);
                            this._menuEvent=null;
                            this._blockerMenu=null;
                            this._handleMenus();
                        }
                    }
                );
            }
        }
    }

    _handleShortcut() {
        let delay_time = this._settings.get_double('shortcut-delay');
        if(this._shortcutTimeout) {
            if(this._shortcutTimeout !== true) {
                GLib.source_remove(this._shortcutTimeout);
            }
            this._shortcutTimeout = null;
            if(delay_time < 0.05
               || this._settings.get_boolean('shortcut-toggles')) {
                this._intellihideBlock = false;
                this._preventHide = false;
                this.hide(
                    this._settings.get_double('animation-time-autohide'),
                    "shortcut"
                );
                return;
            }
        }

        // If setting 'shortcut-toggles' is false, repeatedly pressing the
        // shortcut should prevent the bar from hiding
        if(!this._preventHide || this._intellihideBlock) {
            this._intellihideBlock = true;
            this._preventHide = true;

            if(delay_time > 0.05) {
                let show_time = Math.min(
                  this._settings.get_double('animation-time-autohide'),
                  Math.max(0.1, delay_time/5.0));
                this.show(show_time, "shortcut");

                this._shortcutTimeout = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, delay_time*1200,
                    () => {
                        this._preventHide = false;
                        this._intellihideBlock = false;
                        this._handleMenus();
                        this._shortcutTimeout = null;
                        return false;
                    }
                );
            } else {
                this.show(
                    this._settings.get_double('animation-time-autohide'),
                    "shortcut"
                );
                this._shortcutTimeout = true;
            }
            // Key-focus the "Activities" button
            //  Currently, this is deactivated because we can't make sure that
            //  the panel doesn't hide as long as it has the key focus.
            // Main -> panel -> _leftBox -> (StBin) -> (panel-button)
            // Main.panel._leftBox.first_child.first_child.grab_key_focus();
        }
    }

    _disablePressureBarrier() {
        if(this._pointerListener) {
            this._pointerWatcher._removeWatch(this._pointerListener);
            this._pointerListener = null;
        }

        if(this._panelBarrier && this._panelPressure) {
            this._panelPressure.removeBarrier(this._panelBarrier);
            this._panelBarrier.destroy();
            this._panelBarrier = null;
        }
    }

    _initPressureBarrier() {
        this._panelPressure = new Layout.PressureBarrier(
            this._settings.get_int('pressure-threshold'),
            this._settings.get_int('pressure-timeout'),
            ShellActionMode.NORMAL
        );
        this._panelPressure.connect(
            'trigger',
            (barrier) => {
                if (
                    Main.layoutManager.primaryMonitor?.inFullscreen
                    && !this._settings.get_boolean(
                        'mouse-sensitive-fullscreen-window'
                    )
                ) {
                    return;
                }
                this.show(
                    this._settings.get_double('animation-time-autohide'),
                    "mouse-enter"
                );
            }
        );
        let anchor_y = PanelBox.get_pivot_point()[1],
            direction = Meta.BarrierDirection.POSITIVE_Y;
        if(anchor_y < 0) {
            anchor_y -= PanelBox.height;
            direction = Meta.BarrierDirection.NEGATIVE_Y;
        }
        this._panelBarrier = new Meta.Barrier({
            ...(shellVersion === 45  ? { display: global.display } : { backend: global.backend }),
            x1: PanelBox.x,
            x2: PanelBox.x + PanelBox.width,
            y1: this._base_y - anchor_y,
            y2: this._base_y - anchor_y,
            directions: direction
        });
        this._panelPressure.addBarrier(this._panelBarrier);
    }

    _updateStaticBox() {
        DEBUG("_updateStaticBox()");
        let anchor_y = PanelBox.get_pivot_point()[1];
        this._staticBox.init_rect(
            PanelBox.x, PanelBox.y-anchor_y, PanelBox.width, PanelBox.height
        );
        this._intellihide.updateTargetBox(this._staticBox);
        this._desktopIconsUsableArea.resetMargins();
        this._desktopIconsUsableArea.setMargins(-1, PanelBox.height, 0, 0, 0);
    }

    _updateHotCorner(panel_hidden) {
        let HotCorner = null;
        for(let i = 0; i < Main.layoutManager.hotCorners.length; i++){
          let hc = Main.layoutManager.hotCorners[i];
          if(hc){
            HotCorner = hc;
            break;
          }
        }
        if(HotCorner){
          if(!panel_hidden || this._settings.get_boolean('hot-corner')) {
              HotCorner.setBarrierSize(PanelBox.height);
          } else {
              GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, function () {
                  HotCorner.setBarrierSize(0)
              });
          }
        }
    }

    _setAffectsStruts(value) {
        Main.layoutManager.removeChrome(PanelBox);
        Main.layoutManager.addChrome(PanelBox, {
            affectsStruts: value,
            trackFullscreen: true
        });
    }

    _onTabletModeChanged() {
        this._inTabletMode = this._seat.touch_mode;
        const showInTablet = this._settings.get_boolean('show-in-tablet-mode');

        if (this._inTabletMode) {
            if (showInTablet) {
                this._cancelTabletAutoHide();
                this._disarmTabletOutsideListener();
                this._disarmTabletTouchListener();
                if (this._animationActive) {
                    PanelBox.remove_all_transitions();
                    this._animationActive = false;
                }
                this._setAffectsStruts(true);
                this._strutsReserved = true;
                this.show(
                    this._settings.get_double('animation-time-autohide'),
                    'tablet-mode-entered'
                );
            } else {
                if (this._strutsReserved) {
                    if (this._animationActive) {
                        PanelBox.remove_all_transitions();
                        this._animationActive = false;
                    }
                    this._setAffectsStruts(false);
                    this._strutsReserved = false;
                }
                this.hide(
                    this._settings.get_double('animation-time-autohide'),
                    'tablet-mode-entered'
                );
                this._armTabletTouchListener();
            }
        } else {
            this._inTabletOverlay = false;
            this._tabletOverlayReady = false;
            this._cancelTabletAutoHide();
            this._disarmTabletOutsideListener();
            this._disarmTabletTouchListener();
            if (this._strutsReserved) {
                if (this._animationActive) {
                    PanelBox.remove_all_transitions();
                    this._animationActive = false;
                }
                this._setAffectsStruts(false);
                this._strutsReserved = false;
            }
            this.hide(
                this._settings.get_double('animation-time-autohide'),
                'tablet-mode-left'
            );
        }
    }

    _armTabletTouchListener() {
        if (this._tabletTouchSignalId) return;
        this._tabletTouchSignalId = global.stage.connect(
            'captured-event',
            this._onTabletEdgeTouch.bind(this)
        );
    }

    _disarmTabletTouchListener() {
        if (this._tabletTouchSignalId) {
            global.stage.disconnect(this._tabletTouchSignalId);
            this._tabletTouchSignalId = null;
        }
    }

    _onTabletEdgeTouch(stage, event) {
        if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (!this._inTabletMode)
            return Clutter.EVENT_PROPAGATE;
        if (PanelBox.visible && PanelBox.y >= this._base_y)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        if (y < 10)
            this._revealTabletOverlay();

        return Clutter.EVENT_PROPAGATE;
    }

    _revealTabletOverlay() {
        this._inTabletOverlay = true;
        this._tabletOverlayReady = false;
        this.show(
            this._settings.get_double('animation-time-autohide'),
            'tablet-edge-swipe'
        );
        this._startTabletAutoHide();
        this._armTabletOutsideListener();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._tabletOverlayReady = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    _startTabletAutoHide() {
        this._cancelTabletAutoHide();
        this._tabletAutoHideId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            5000,
            () => {
                this._tabletAutoHideId = null;
                this._inTabletOverlay = false;
                this._tabletOverlayReady = false;
                this._disarmTabletOutsideListener();
                this.hide(
                    this._settings.get_double('animation-time-autohide'),
                    'tablet-auto-hide'
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelTabletAutoHide() {
        if (this._tabletAutoHideId) {
            GLib.source_remove(this._tabletAutoHideId);
            this._tabletAutoHideId = null;
        }
    }

    _armTabletOutsideListener() {
        if (this._tabletOutsideSignalId) return;
        this._tabletOutsideSignalId = global.stage.connect(
            'captured-event',
            this._onTabletOutsideTouch.bind(this)
        );
    }

    _disarmTabletOutsideListener() {
        if (this._tabletOutsideSignalId) {
            global.stage.disconnect(this._tabletOutsideSignalId);
            this._tabletOutsideSignalId = null;
        }
    }

    _onTabletOutsideTouch(stage, event) {
        if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const [, y] = event.get_coords();
        if (y < PanelBox.height) {
            // Touch is within the panel area — cancel the auto-hide timer so the
            // bar stays up until the user touches outside, but only once the
            // 500ms debounce has elapsed (to ignore the triggering swipe itself)
            if (this._tabletOverlayReady)
                this._cancelTabletAutoHide();
            return Clutter.EVENT_PROPAGATE;
        }

        // Touch is outside the panel — defer if a panel menu is open,
        // otherwise hide immediately
        const activeMenu = Main.panel.menuManager.activeMenu;
        if (activeMenu) {
            this._cancelTabletAutoHide();
            this._disarmTabletOutsideListener();
            this._tabletMenuEvent = activeMenu.connect(
                'open-state-changed',
                (menu, open) => {
                    if (!open) {
                        menu.disconnect(this._tabletMenuEvent);
                        this._tabletMenuEvent = null;
                        this._inTabletOverlay = false;
                        this._tabletOverlayReady = false;
                        this.hide(0, 'tablet-touch-outside');
                    }
                }
            );
            return Clutter.EVENT_PROPAGATE;
        }

        this._inTabletOverlay = false;
        this._tabletOverlayReady = false;
        this._cancelTabletAutoHide();
        this._disarmTabletOutsideListener();
        this.hide(0, 'tablet-touch-outside');
        return Clutter.EVENT_PROPAGATE;
    }

    _updateSettingsHotCorner() {
        this.hide(0.1, "hot-corner-setting-changed");
    }

    _updateSettingsMouseSensitive() {
        if(this._settings.get_boolean('mouse-sensitive')) {
            this._disablePressureBarrier();
            this._initPressureBarrier();
        } else this._disablePressureBarrier();
    }

    _updateSettingsShowInOverview() {
        this._showInOverview = this._settings.get_boolean('show-in-overview');
        this._updateSearchEntryPadding();
    }

    _updateSearchEntryPadding() {
        if (!_searchEntryBin) return;
        if (!Main.layoutManager.primaryMonitor) return;
        const scale = Main.layoutManager.primaryMonitor.geometry_scale;
        const offset = PanelBox.height / scale;
        _searchEntryBin.set_style(
            this._showInOverview ? `padding-top: ${offset}px;` : null
        );
    }

    _updateIntellihideStatus() {
        if(this._settings.get_boolean('enable-intellihide')) {
            this._intellihideBlock = false;
            this._preventHide = false;
            this._intellihide.enable();
        } else {
            this._intellihide.disable();
            this._intellihideBlock = true;
            this._preventHide = false;
            this.hide(0, "init");
        }
    }

    _updatePreventHide() {
        if(this._intellihideBlock) return;

        this._preventHide = !this._intellihide.getOverlapStatus();
        let animTime = this._settings.get_double('animation-time-autohide');
        if(this._preventHide) {
            if (this._showInOverview || !Main.overview.visible)
                this.show(animTime, "intellihide");
        } else if(!Main.overview.visible)
            this.hide(animTime, "intellihide");
    }

    _bindUIChanges() {
        this._signalsHandler = new Convenience.GlobalSignalsHandler();
        this._signalsHandler.add(
            [
                Main.overview,
                'showing',
                () => {
                    if(this._showInOverview) {
                        this.show(
                            this._settings.get_double(
                                'animation-time-overview'
                            ),
                            "showing-overview"
                        );
                    }
                }
            ],
            [
                Main.overview,
                'hiding',
                () => {
                    this.hide(
                        this._settings.get_double('animation-time-overview'),
                        "hiding-overview"
                    );
                }
            ],
            [
                Main.panel,
                'leave-event',
                this._handleMenus.bind(this)
            ],
            [
                PanelBox,
                'notify::anchor-y',
                () => {
                    this._updateStaticBox();
                    this._updateSettingsMouseSensitive();
                }
            ],
            [
                PanelBox,
                'notify::height',
                this._updateSearchEntryPadding.bind(this)
            ],
            [
                Main.layoutManager,
                'monitors-changed',
                () => {
                    this._base_y = PanelBox.y;
                    this._updateStaticBox();
                    this._updateSettingsMouseSensitive();
                }
            ],
            [
                this._intellihide,
                'status-changed',
                this._updatePreventHide.bind(this)
            ]
        );

        Main.wm.addKeybinding("shortcut-keybind",
            this._settings, Meta.KeyBindingFlags.NONE,
            ShellActionMode.NORMAL,
            this._handleShortcut.bind(this)
        );

        if (!PanelBox.has_allocation()) {
          // after login, allocating the panel can take a second or two
          let tmp_handle = PanelBox.connect("notify::allocation", () => {
            this._updateIntellihideStatus();
            PanelBox.disconnect(tmp_handle);
          });
        } else {
          this._updateIntellihideStatus();
        }

        this._bindTimeoutId = 0;
        return false;
    }

    _bindSettingsChanges() {
        this._signalsHandler = new Convenience.GlobalSignalsHandler();
        this._signalsHandler.addWithLabel("settings",
            [
                this._settings,
                'changed::hot-corner',
                this._updateSettingsHotCorner.bind(this)
            ],
            [
                this._settings,
                'changed::mouse-sensitive',
                this._updateSettingsMouseSensitive.bind(this)
            ],
            [
                this._settings,
                'changed::pressure-timeout',
                this._updateSettingsMouseSensitive.bind(this)
            ],
            [
                this._settings,
                'changed::pressure-threshold',
                this._updateSettingsMouseSensitive.bind(this)
            ],
            [
                this._settings,
                'changed::show-in-overview',
                this._updateSettingsShowInOverview.bind(this)
            ],
            [
                this._settings,
                'changed::enable-intellihide',
                this._updateIntellihideStatus.bind(this)
            ],
            [
                this._settings,
                'changed::enable-active-window',
                this._updateIntellihideStatus.bind(this)
            ],
            [
                this._settings,
                'changed::show-in-tablet-mode',
                this._onTabletModeChanged.bind(this)
            ]
        );
    }

    destroy() {
        if (this._bindTimeoutId) {
            GLib.source_remove(this._bindTimeoutId);
            this._bindTimeoutId = 0;
        }
        this._inTabletOverlay = false;
        this._tabletOverlayReady = false;
        if (this._tabletMenuEvent) {
            Main.panel.menuManager.activeMenu?.disconnect(this._tabletMenuEvent);
            this._tabletMenuEvent = null;
        }
        this._cancelTabletAutoHide();
        this._disarmTabletOutsideListener();
        this._disarmTabletTouchListener();
        this._strutsReserved = false;
        this._seat.disconnect(this._tabletModeSignal);
        this._intellihide.destroy();
        this._signalsHandler.destroy();
        Main.wm.removeKeybinding("shortcut-keybind");
        this._disablePressureBarrier();
        if (_searchEntryBin) {
          _searchEntryBin.style = null;
        }

        MessageTray._bannerBin.ease = this._oldEase;
        this.show(0, "destroy");

        this._setAffectsStruts(true);
        this._desktopIconsUsableArea.destroy();
        this._desktopIconsUsableArea = null;
    }
};
