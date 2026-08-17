/**
 * Injected stylesheet: uses the DSH theme alias tokens (--dsw-alias-*)
 * so light/dark themes both render correctly without our own theme logic.
 * Accent hues are fixed mid-saturation colors (legible on both themes);
 * every tint is derived via color-mix so surfaces stay theme-native.
 *
 * Also fixes a latent bug from 0.1.x: --dsw-alias-fill-l2 does not exist
 * in the shipped theme CSS — those backgrounds silently vanished. All
 * former fill usages now use real tokens / color-mix.
 *
 * @module dsh-devlaunch/client/styles
 */

/** The stylesheet text. */
const CSS = `
/* ================= tokens (scoped to our mount roots) ================= */
.dl-root, .dl-console-root, .dl-modal-scrim {
  --dl-blue: #4176e6;
  --dl-green: var(--dsw-alias-state-success-primary, #22c55e);
  --dl-red: var(--dsw-alias-state-error-primary, #ef4444);
  --dl-amber: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dl-violet: #8b5cf6;
}
.dl-root :focus-visible, .dl-console-root :focus-visible, .dl-modal-scrim :focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dl-blue) 60%, transparent);
  outline-offset: 1px;
}

/* ================= keyframes ================= */
@keyframes dl-pop-in {
  from { opacity: 0; transform: translateY(-4px) scale(.985); }
  to { opacity: 1; transform: none; }
}
@keyframes dl-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dl-modal-in {
  from { opacity: 0; transform: translateY(10px) scale(.985); }
  to { opacity: 1; transform: none; }
}
@keyframes dl-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dl-green) 45%, transparent); }
  70% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--dl-green) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dl-green) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .dl-root *, .dl-console-root *, .dl-modal-scrim * {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}

/* ================= scrollbars ================= */
.dl-menu::-webkit-scrollbar, .dl-modal-body::-webkit-scrollbar,
.dl-console-scroll::-webkit-scrollbar, .dl-rail-list::-webkit-scrollbar {
  width: 8px; height: 8px;
}
.dl-menu::-webkit-scrollbar-thumb, .dl-modal-body::-webkit-scrollbar-thumb,
.dl-console-scroll::-webkit-scrollbar-thumb, .dl-rail-list::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,.22));
  border-radius: 8px; border: 2px solid transparent; background-clip: padding-box;
}
.dl-menu::-webkit-scrollbar-thumb:hover, .dl-modal-body::-webkit-scrollbar-thumb:hover,
.dl-console-scroll::-webkit-scrollbar-thumb:hover, .dl-rail-list::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l2, rgba(0,0,0,.32));
  border: 2px solid transparent; background-clip: padding-box;
}

/* ================= header split pill ================= */
.dl-root { position: relative; display: inline-flex; align-items: center; }
.dl-pill {
  display: inline-flex; align-items: stretch; height: 27px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  overflow: hidden; transition: border-color .15s ease, box-shadow .15s ease;
}
.dl-pill[data-state="idle"]:hover:not(.dl-pill-disabled) {
  border-color: color-mix(in srgb, var(--dl-blue) 45%, var(--dsw-alias-border-l2));
  box-shadow: 0 1px 8px color-mix(in srgb, var(--dl-blue) 14%, transparent);
}
.dl-pill[data-state="running"] {
  border-color: color-mix(in srgb, var(--dl-green) 45%, var(--dsw-alias-border-l2));
}
.dl-pill[data-state="running"]:hover:not(.dl-pill-disabled) {
  border-color: color-mix(in srgb, var(--dl-red) 50%, var(--dsw-alias-border-l2));
  box-shadow: 0 1px 8px color-mix(in srgb, var(--dl-red) 14%, transparent);
}
.dl-pill[data-state="empty"] { border-style: dashed; }
.dl-pill[data-state="empty"]:hover:not(.dl-pill-disabled) {
  border-color: color-mix(in srgb, var(--dl-amber) 60%, var(--dsw-alias-border-l2));
  box-shadow: 0 1px 8px color-mix(in srgb, var(--dl-amber) 14%, transparent);
}
.dl-pill-disabled { opacity: .55; }
.dl-trigger {
  display: inline-flex; align-items: center; gap: 6px; padding: 0 10px 0 9px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: 0;
  font-size: 12px; line-height: 18px; font-weight: 500; transition: color .15s ease;
}
.dl-pill:hover:not(.dl-pill-disabled) .dl-trigger { color: var(--dsw-alias-label-primary); }
.dl-trigger:disabled { cursor: default; }
.dl-pill-ico { color: var(--dl-blue); display: inline-flex; flex: none; }
.dl-pill[data-state="running"] .dl-pill-ico { color: var(--dl-red); }
.dl-pill[data-state="empty"] .dl-pill-ico { color: var(--dl-amber); }
.dl-pill-div { width: 1px; background: var(--dsw-alias-border-l2); margin: 5px 0; flex: none; }
.dl-caret-btn {
  display: inline-flex; align-items: center; padding: 0 8px; cursor: pointer;
  background: 0 0; border: 0; color: var(--dsw-alias-label-tertiary); transition: color .15s ease;
}
.dl-pill:hover:not(.dl-pill-disabled) .dl-caret-btn { color: var(--dsw-alias-label-secondary); }
.dl-caret-btn:disabled { cursor: default; }
.dl-caret-btn svg { transition: transform .16s ease; }
.dl-caret-flip { transform: rotate(180deg); }

/* ================= status dots ================= */
.dl-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; display: inline-block; }
.dl-dot-on {
  background: var(--dl-green);
  animation: dl-pulse 1.9s ease-out infinite;
}
.dl-dot-off { background: var(--dsw-alias-label-tertiary); opacity: .55; }
.dl-dot-err {
  background: var(--dl-red);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-red) 18%, transparent);
}

/* ================= dropdown menu ================= */
.dl-menu {
  z-index: 100; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base));
  width: 380px; max-width: min(420px, 100vw - 32px);
  max-height: min(460px, 100vh - 140px);
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.22));
  border-radius: 12px; display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 4px;
  position: absolute; top: calc(100% + 6px); right: 0; overflow: auto;
  animation: dl-pop-in .16s cubic-bezier(.2,.9,.3,1);
}
.dl-menu-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px 5px; }
.dl-menu-title {
  color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600;
  letter-spacing: .02em; display: inline-flex; align-items: center; gap: 6px;
}
.dl-menu-title svg { color: var(--dl-blue); }
.dl-menu-config {
  display: inline-flex; align-items: center; gap: 5px;
  background: 0 0; border: 0; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px;
  border-radius: 7px; padding: 3px 7px; transition: color .12s, background .12s;
}
.dl-menu-config:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dl-menu-error {
  margin: 2px 6px 4px; padding: 7px 10px; border-radius: 8px; font-size: 12px;
  color: var(--dl-red); background: color-mix(in srgb, var(--dl-red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dl-red) 22%, transparent);
}
.dl-menu-row {
  display: flex; align-items: center; gap: 8px; min-height: 36px; border-radius: 8px;
  padding: 5px 8px; font-size: 13px; color: var(--dsw-alias-label-primary);
  transition: background .12s ease;
}
.dl-menu-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dl-menu-row[data-running] { color: var(--dsw-alias-label-primary); }

/* kind chips (shared everywhere) */
.dl-kind {
  flex: none; border-radius: 5px; padding: 0 6px; font-size: 11px; line-height: 18px; font-weight: 500;
}
.dl-kind[data-kind="frontend"] {
  color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 13%, transparent);
}
.dl-kind[data-kind="backend"] {
  color: var(--dl-green); background: color-mix(in srgb, var(--dl-green) 13%, transparent);
}
.dl-kind[data-kind="other"] {
  color: var(--dl-violet); background: color-mix(in srgb, var(--dl-violet) 13%, transparent);
}

.dl-row-label {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--ds-font-family-code, monospace); font-size: 12px;
}
.dl-row-status {
  flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 11px;
}
.dl-row-actions { display: inline-flex; gap: 2px; flex: none; }
.dl-menu-empty {
  padding: 18px 14px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px;
  display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
}
.dl-menu-empty svg { opacity: .55; }
.dl-menu-foot { display: flex; gap: 6px; padding: 6px; border-top: 1px solid var(--dsw-alias-border-l2); margin-top: 3px; }

/* ================= shared small controls ================= */
.dl-mini {
  min-width: 24px; height: 24px; display: inline-grid; place-items: center; cursor: pointer;
  background: 0 0; border: 1px solid transparent; border-radius: 7px;
  color: var(--dsw-alias-label-tertiary); padding: 0 3px;
  transition: color .12s, background .12s, border-color .12s;
}
.dl-mini:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dl-mini:active:not(:disabled) { transform: translateY(.5px); }
.dl-mini:disabled { opacity: .35; cursor: default; }
.dl-mini-go:hover:not(:disabled) { color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 12%, transparent); }
.dl-mini-stop:hover:not(:disabled) { color: var(--dl-red); background: color-mix(in srgb, var(--dl-red) 12%, transparent); }
.dl-mini-restart:hover:not(:disabled) { color: var(--dl-amber); background: color-mix(in srgb, var(--dl-amber) 12%, transparent); }
.dl-mini-copy:hover:not(:disabled) { color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 12%, transparent); }
.dl-mini-copy-done { color: var(--dl-green); }

.dl-foot-btn {
  flex: 1; min-height: 30px; cursor: pointer; background: 0 0;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: color .12s, background .12s, border-color .12s;
}
.dl-foot-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dl-foot-btn:active:not(:disabled) { transform: translateY(.5px); }
.dl-foot-btn:disabled { opacity: .4; cursor: default; }
.dl-foot-btn.dl-foot-danger:hover:not(:disabled) {
  color: var(--dl-red); border-color: color-mix(in srgb, var(--dl-red) 40%, transparent);
  background: color-mix(in srgb, var(--dl-red) 8%, transparent);
}
.dl-foot-go {
  color: #fff; background: var(--dl-blue); border-color: transparent;
  box-shadow: 0 1px 6px color-mix(in srgb, var(--dl-blue) 30%, transparent);
}
.dl-foot-go:hover:not(:disabled) {
  color: #fff; background: color-mix(in srgb, var(--dl-blue) 86%, #000);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--dl-blue) 38%, transparent);
}

/* ================= console view (session tab) ================= */
.dl-console-root { display: flex; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); }
.dl-console-rail {
  width: 230px; flex: none; display: flex; flex-direction: column; padding: 10px 8px 8px;
  border-right: 1px solid var(--dsw-alias-border-l2); overflow: hidden;
}
.dl-rail-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.dl-rail-head {
  display: flex; justify-content: space-between; align-items: center; padding: 0 6px 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600;
}
.dl-conn { color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.dl-conn-on { color: var(--dl-green); font-size: 10px; }
.dl-rail-item {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; cursor: pointer;
  background: 0 0; border: 0; border-radius: 8px; padding: 7px 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px;
  transition: background .12s, color .12s;
}
.dl-rail-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dl-rail-item-on {
  background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary);
  box-shadow: inset 2px 0 0 var(--dl-blue);
}
.dl-rail-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-rail-dur { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
.dl-rail-dur-run { color: var(--dl-green); }
.dl-rail-dur-err { color: var(--dl-red); }
.dl-rail-empty {
  padding: 18px 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px;
  display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; line-height: 18px;
}
.dl-rail-empty svg { opacity: .5; }
.dl-rail-config {
  cursor: pointer; background: 0 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 5px 12px; width: fit-content;
  display: inline-flex; align-items: center; gap: 6px; transition: all .12s;
}
.dl-rail-config:hover {
  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
  background: color-mix(in srgb, var(--dl-blue) 8%, transparent);
}
.dl-rail-foot {
  flex: none; display: flex; gap: 6px; padding-top: 8px; margin-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dl-rail-foot-btn {
  flex: 1; min-height: 27px; cursor: pointer; background: 0 0;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; padding: 3px 6px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  transition: all .12s;
}
.dl-rail-foot-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dl-rail-foot-btn:disabled { opacity: .35; cursor: default; }
.dl-rail-foot-go:hover:not(:disabled) { color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent); background: color-mix(in srgb, var(--dl-blue) 8%, transparent); }
.dl-rail-foot-stop:hover:not(:disabled) { color: var(--dl-red); border-color: color-mix(in srgb, var(--dl-red) 45%, transparent); background: color-mix(in srgb, var(--dl-red) 8%, transparent); }

/* ---- console main ---- */
.dl-console-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dl-console-bar {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); flex: none; flex-wrap: wrap;
}
.dl-console-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; white-space: nowrap; }
.dl-console-cmd {
  font-family: var(--ds-font-family-code, monospace); font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-interactive-bg-hover));
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 2px 7px;
  max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dl-console-cwd {
  font-family: var(--ds-font-family-code, monospace); font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.dl-chip {
  display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px;
  font-size: 11px; line-height: 16px; border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums;
}
.dl-chip[data-state="running"] {
  color: var(--dl-green); border-color: color-mix(in srgb, var(--dl-green) 35%, transparent);
  background: color-mix(in srgb, var(--dl-green) 9%, transparent);
}
.dl-chip[data-state="error"] {
  color: var(--dl-red); border-color: color-mix(in srgb, var(--dl-red) 35%, transparent);
  background: color-mix(in srgb, var(--dl-red) 9%, transparent);
}
.dl-console-actions { display: inline-flex; gap: 3px; margin-left: auto; flex: none; }

.dl-console-scroll {
  flex: 1; min-height: 0; overflow-y: auto; padding: 10px 0 16px;
  font-family: var(--ds-font-family-code, monospace); font-size: 12px; line-height: 19px;
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-base));
}
.dl-line { display: flex; gap: 10px; padding: 0 12px; white-space: pre-wrap; word-break: break-word; }
.dl-line:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dl-line-seq {
  flex: none; width: 44px; text-align: right; color: var(--dsw-alias-label-tertiary);
  opacity: .55; user-select: none; font-size: 10px; line-height: 19px;
}
.dl-line-text { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); }
.dl-line-err .dl-line-text { color: var(--dl-red); }
.dl-mark {
  background: color-mix(in srgb, var(--dl-amber) 38%, transparent);
  color: inherit; border-radius: 2px; padding: 0 1px;
}
.dl-console-nooutput, .dl-console-empty {
  padding: 48px 24px; color: var(--dsw-alias-label-tertiary); font-size: 13px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; height: 100%; box-sizing: border-box; text-align: center;
}
.dl-console-nooutput svg, .dl-console-empty svg { opacity: .45; }
.dl-follow-btn {
  position: sticky; bottom: 12px; margin: 0 auto; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 84%, transparent);
  backdrop-filter: blur(6px);
  color: var(--dsw-alias-label-secondary); border-radius: 999px; font-size: 11px; padding: 5px 14px;
  box-shadow: var(--dsw-shadow-lv2, 0 2px 10px rgba(0,0,0,.15));
  display: inline-flex; align-items: center; gap: 6px;
  animation: dl-fade-in .15s ease; transition: color .12s, border-color .12s;
}
.dl-follow-btn:hover {
  color: var(--dsw-alias-label-primary);
  border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
}

/* ---- console search / filter ---- */
.dl-search-wrap { position: relative; display: inline-flex; align-items: center; flex: none; }
.dl-search-wrap > svg {
  position: absolute; left: 8px; color: var(--dsw-alias-label-tertiary); pointer-events: none;
}
.dl-search {
  height: 26px; width: 160px; border-radius: 8px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-size: 12px; padding: 0 8px 0 27px;
  transition: border-color .15s, box-shadow .15s, width .2s ease;
}
.dl-search:focus {
  outline: none; width: 200px;
  border-color: color-mix(in srgb, var(--dl-blue) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-blue) 14%, transparent);
}
.dl-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.dl-toggle-btn {
  height: 26px; display: inline-flex; align-items: center; gap: 5px; padding: 0 9px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: 0 0;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; cursor: pointer;
  transition: color .12s, background .12s, border-color .12s; flex: none;
}
.dl-toggle-btn:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.dl-toggle-btn[aria-pressed="true"] {
  color: var(--dl-red);
  border-color: color-mix(in srgb, var(--dl-red) 40%, transparent);
  background: color-mix(in srgb, var(--dl-red) 10%, transparent);
}
.dl-filter-count {
  font-size: 10px; color: var(--dsw-alias-label-tertiary); white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ================= config modal ================= */
.dl-modal-scrim {
  position: fixed; inset: 0; z-index: 200;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.4));
  backdrop-filter: blur(3px);
  display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px;
  animation: dl-fade-in .18s ease;
}
.dl-modal {
  width: 660px; max-width: 100%; max-height: 84vh; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px;
  box-shadow: var(--dsw-shadow-lv3, 0 16px 44px rgba(0,0,0,.3));
  animation: dl-modal-in .2s cubic-bezier(.2,.9,.3,1);
}
.dl-modal-head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dl-modal-badge {
  width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; flex: none;
  color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 12%, transparent);
}
.dl-modal-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dl-modal-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); display: inline-flex; gap: 3px; align-items: center; }
.dl-modal-close {
  margin-left: auto; width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer;
  background: 0 0; border: 0; border-radius: 8px; color: var(--dsw-alias-label-tertiary);
  transition: color .12s, background .12s;
}
.dl-modal-close:hover { background: color-mix(in srgb, var(--dl-red) 12%, transparent); color: var(--dl-red); }
.dl-modal-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.dl-form-row {
  border: 1px solid var(--dsw-alias-border-l2); border-left-width: 3px;
  border-radius: 10px; padding: 10px 10px 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
  transition: border-color .15s, box-shadow .15s;
}
.dl-form-row:hover {
  border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 35%, var(--dsw-alias-border-l2));
  border-left-color: var(--dl-row-accent, var(--dl-blue));
}
.dl-form-row[data-kind="frontend"] { border-left-color: var(--dl-blue); --dl-row-accent: var(--dl-blue); }
.dl-form-row[data-kind="backend"] { border-left-color: var(--dl-green); --dl-row-accent: var(--dl-green); }
.dl-form-row[data-kind="other"] { border-left-color: var(--dl-violet); --dl-row-accent: var(--dl-violet); }
.dl-form-line1 { display: flex; align-items: center; gap: 8px; }
.dl-form-kind {
  flex: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; padding: 3px 4px; height: 26px; cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
.dl-form-label {
  flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; padding: 4px 9px; height: 26px; box-sizing: border-box;
  transition: border-color .15s, box-shadow .15s;
}
.dl-form-command, .dl-form-cwd, .dl-form-env {
  width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code, monospace); font-size: 12px; padding: 5px 9px;
  transition: border-color .15s, box-shadow .15s;
}
.dl-form-kind:focus, .dl-form-label:focus, .dl-form-command:focus, .dl-form-cwd:focus, .dl-form-env:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--dl-blue) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-blue) 14%, transparent);
}
.dl-form-label::placeholder, .dl-form-command::placeholder,
.dl-form-cwd::placeholder, .dl-form-env::placeholder {
  color: var(--dsw-alias-label-tertiary);
}

/* toggle switch */
.dl-switch {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 12px; user-select: none; flex: none;
}
.dl-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dl-switch-track {
  width: 30px; height: 17px; border-radius: 999px; flex: none; position: relative;
  background: var(--dsw-alias-interactive-bg-hover);
  border: 1px solid var(--dsw-alias-border-l2);
  transition: background .16s, border-color .16s;
}
.dl-switch-track::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
  border-radius: 999px; background: var(--dsw-alias-label-tertiary);
  transition: transform .16s ease, background .16s;
}
.dl-switch input:checked + .dl-switch-track {
  background: color-mix(in srgb, var(--dl-green) 60%, transparent);
  border-color: color-mix(in srgb, var(--dl-green) 60%, transparent);
}
.dl-switch input:checked + .dl-switch-track::after { transform: translateX(13px); background: #fff; }
.dl-switch input:focus-visible + .dl-switch-track {
  outline: 2px solid color-mix(in srgb, var(--dl-blue) 60%, transparent); outline-offset: 1px;
}

.dl-form-order { display: inline-flex; gap: 2px; }
.dl-form-line3 { display: flex; gap: 8px; }
.dl-form-cwd { flex: 1; }
.dl-form-env {
  flex: 1; resize: vertical; min-height: 40px; font-size: 11px;
}

/* add buttons */
.dl-form-adds { display: flex; gap: 6px; flex-wrap: wrap; }
.dl-add-btn {
  min-height: 30px; cursor: pointer; background: 0 0;
  border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 12px;
  display: inline-flex; align-items: center; gap: 6px;
  transition: color .13s, border-color .13s, background .13s, border-style .13s;
}
.dl-add-btn:hover { border-style: solid; color: var(--dsw-alias-label-primary); }
.dl-add-btn[data-kind="frontend"]:hover {
  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
  background: color-mix(in srgb, var(--dl-blue) 8%, transparent);
}
.dl-add-btn[data-kind="backend"]:hover {
  color: var(--dl-green); border-color: color-mix(in srgb, var(--dl-green) 45%, transparent);
  background: color-mix(in srgb, var(--dl-green) 8%, transparent);
}
.dl-add-btn[data-kind="other"]:hover {
  color: var(--dl-violet); border-color: color-mix(in srgb, var(--dl-violet) 45%, transparent);
  background: color-mix(in srgb, var(--dl-violet) 8%, transparent);
}
.dl-add-btn[data-import]:hover {
  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
  background: color-mix(in srgb, var(--dl-blue) 8%, transparent);
}

/* import suggestions */
.dl-suggest {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden;
}
.dl-suggest-head {
  display: flex; justify-content: space-between; align-items: center; padding: 7px 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary); font-size: 12px;
}
.dl-suggest-empty { padding: 12px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dl-suggest-row {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
  background: 0 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1);
  padding: 6px 10px; transition: background .12s;
}
.dl-suggest-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dl-suggest-cwd {
  flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-interactive-bg-hover));
  border-radius: 5px; font-size: 10px; padding: 1px 6px;
}
.dl-suggest-name {
  flex: none; width: 110px; overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary); font-size: 12px;
}
.dl-suggest-cmd {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 11px;
}
.dl-suggest-add {
  flex: none; color: var(--dl-blue); font-size: 11px;
  display: inline-flex; align-items: center; gap: 3px;
}

/* modal footer */
.dl-modal-foot {
  display: flex; align-items: center; gap: 8px; padding: 12px 16px 14px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dl-modal-note { margin-right: auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dl-modal-foot .dl-foot-btn { flex: none; min-width: 84px; }

/* ================= ready / restarts / ports ================= */
.dl-dot-ready {
  background: var(--dl-green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-green) 22%, transparent);
}
.dl-status-ready { color: var(--dl-blue); }
.dl-restart-badge {
  flex: none; display: inline-flex; align-items: center; gap: 3px;
  color: var(--dl-amber); font-size: 10px; font-variant-numeric: tabular-nums;
}
.dl-ports { display: inline-flex; gap: 4px; flex: none; }
.dl-port-chip {
  display: inline-flex; align-items: center; gap: 3px; border-radius: 6px; padding: 1px 7px;
  font-size: 10px; line-height: 16px; text-decoration: none; cursor: pointer;
  font-family: var(--ds-font-family-code, monospace); font-variant-numeric: tabular-nums;
  color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dl-blue) 25%, transparent);
  transition: background .12s, border-color .12s;
}
.dl-port-chip:hover {
  background: color-mix(in srgb, var(--dl-blue) 18%, transparent);
  border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
}
.dl-port-chip[data-conflict="true"] {
  color: var(--dl-red); background: color-mix(in srgb, var(--dl-red) 10%, transparent);
  border-color: color-mix(in srgb, var(--dl-red) 40%, transparent);
}
.dl-rail-item[data-conflict="true"] { box-shadow: inset 2px 0 0 var(--dl-red); }
.dl-menu-row[data-conflict="true"] { box-shadow: inset 2px 0 0 var(--dl-red); }

/* ================= profile selector ================= */
.dl-profile-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 0 6px 6px; }
.dl-profile-label {
  flex: none; color: var(--dsw-alias-label-tertiary); font-size: 10px;
  display: inline-flex; align-items: center; gap: 3px; margin-right: 2px;
}
.dl-profile-chip {
  border-radius: 999px; padding: 2px 10px; font-size: 11px; line-height: 16px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: 0 0;
  color: var(--dsw-alias-label-tertiary); transition: color .12s, border-color .12s, background .12s;
}
.dl-profile-chip:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.dl-profile-chip[data-on="true"] {
  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
  background: color-mix(in srgb, var(--dl-blue) 9%, transparent); font-weight: 500;
}

/* ================= modal: group options + profiles editor ================= */
.dl-form-line4 { display: flex; gap: 8px; align-items: flex-end; }
.dl-form-line4 .dl-form-env { flex: 1; }
.dl-form-opt {
  flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 0 2px 4px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; user-select: none;
  white-space: nowrap;
}
.dl-profiles-card {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
}
.dl-profiles-head {
  display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary);
  font-size: 12px; font-weight: 600;
}
.dl-profiles-head svg { color: var(--dl-blue); }
.dl-profiles-head button { margin-left: auto; }
.dl-profile-row { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); }
.dl-profile-line1 { display: flex; align-items: center; gap: 6px; }
.dl-profile-name {
  flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; padding: 4px 9px; height: 26px; box-sizing: border-box;
  transition: border-color .15s, box-shadow .15s;
}
.dl-profile-name:focus {
  outline: none; border-color: color-mix(in srgb, var(--dl-blue) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-blue) 14%, transparent);
}
.dl-profile-members { display: flex; gap: 4px; flex-wrap: wrap; }
.dl-member-chip {
  border-radius: 6px; padding: 1px 8px; font-size: 11px; line-height: 17px; cursor: pointer;
  border: 1px dashed var(--dsw-alias-border-l2); background: 0 0;
  color: var(--dsw-alias-label-tertiary); transition: color .12s, border-color .12s, background .12s;
}
.dl-member-chip:hover { color: var(--dsw-alias-label-secondary); }
.dl-member-chip[data-on="true"] {
  color: var(--dl-blue); border-style: solid;
  border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
  background: color-mix(in srgb, var(--dl-blue) 9%, transparent);
}
.dl-profiles-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; padding: 2px 2px 0; }
`

/** Style tag marker. */
const STYLE_ID = 'dsh-devlaunch-styles'

/** Inject once. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
