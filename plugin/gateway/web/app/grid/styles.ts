// SPDX-License-Identifier: Apache-2.0
/**
 * The file grid's stylesheet, scoped under `.fg`. It's a plain CSS string (not
 * Tailwind classes) because the grid also renders on the public /p/<id> page,
 * which doesn't load the admin stylesheet. Stone palette only: the viewer is
 * gateway chrome, not the user's content.
 */
export const GRID_CSS = `
.fg{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;background:#fff;color:#1c1917;font-size:13px;line-height:1.5}
.fg *{box-sizing:border-box}
.fg-fx{flex:none;display:flex;align-items:stretch;border-bottom:1px solid #e7e5e4;background:#fff;min-height:32px}
.fg-ref{flex:none;display:flex;align-items:center;gap:.35rem;min-width:9rem;max-width:16rem;padding:0 .75rem;border-right:1px solid #e7e5e4;color:#57534e;white-space:nowrap;overflow:hidden}
.fg-ref b{font-weight:600;color:#1c1917;overflow:hidden;text-overflow:ellipsis}
.fg-val{flex:1;min-width:0;padding:.4rem .75rem;white-space:pre-wrap;word-break:break-word;max-height:7.5em;overflow:auto;user-select:text}
.fg-val.hint{color:#a8a29e}
.fg-st{flex:none;display:flex;align-items:center;gap:.5rem;padding:0 .75rem;color:#78716c;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.fg-btn{font:inherit;font-size:12px;color:#44403c;background:#fafaf9;border:1px solid #d6d3d1;border-radius:.4rem;padding:.1rem .5rem;cursor:pointer;white-space:nowrap}
.fg-btn:hover{background:#f5f5f4}
@media (max-width:600px){.fg-ref{min-width:0;max-width:40%}.fg-st .fg-count{display:none}}
.fg-sc{flex:1;min-height:0;overflow:auto;position:relative;outline:none;background:#fff}
.fg-gw{position:relative;user-select:none}
.fg-r{display:flex;position:relative}
.fg-c,.fg-n{flex:none;height:100%;padding:0 8px;border-right:1px solid #e7e5e4;border-bottom:1px solid #e7e5e4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:26px;cursor:cell}
.fg-c.num{text-align:right;font-variant-numeric:tabular-nums}
.fg-n{position:sticky;left:0;z-index:1;width:var(--gw);padding:0 6px;background:#fafaf9;color:#a8a29e;font-size:11px;text-align:right;cursor:default;user-select:none}
.fg-h{position:sticky;top:0;z-index:3;height:30px}
.fg-h .fg-c{position:relative;display:flex;align-items:center;gap:2px;padding-right:9px;background:#fafaf9;font-weight:600;color:#44403c;line-height:30px;cursor:default;user-select:none;border-bottom-color:#d6d3d1}
.fg-h .fg-c.num{justify-content:flex-end}
.fg-h .fg-n{z-index:4;border-bottom-color:#d6d3d1}
.fg-hn{min-width:0;overflow:hidden;text-overflow:ellipsis}
.fg-h .fg-c:not(.num) .fg-hn{flex:1}
.fg-si{flex:none;font-size:11px;color:#57534e}
.fg-fb{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:#a8a29e;cursor:pointer;opacity:0}
.fg-h .fg-c:hover .fg-fb,.fg-fb.act,.fg-fb.open{opacity:1}
.fg-fb:hover{background:#e7e5e4;color:#1c1917}
.fg-fb.act{color:#1c1917;background:#e7e5e4}
@media (hover:none){.fg-fb{opacity:1}}
.fg-r.wrap .fg-c{white-space:pre-wrap;word-break:break-word;line-height:20px;padding-top:3px;padding-bottom:3px;text-overflow:clip}
.fg-n.hl,.fg-h .fg-c.hl{background:#e7e5e4;color:#1c1917}
.fg-sel,.fg-act{position:absolute;pointer-events:none;z-index:0}
.fg-sel{background:rgba(28,25,23,.07);box-shadow:inset 0 0 0 1px #57534e}
.fg-act{box-shadow:inset 0 0 0 2px #1c1917}
.fg-empty{padding:1.25rem 1rem;color:#78716c}
.fg-cr{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;z-index:2}
.fg-rr{position:absolute;left:0;right:0;bottom:0;height:6px;cursor:row-resize;z-index:2}
.fg-cr:hover,.fg-cr.drag{background:linear-gradient(90deg,transparent 4px,#78716c 4px,#78716c 6px,transparent 6px)}
.fg-rr:hover,.fg-rr.drag{background:linear-gradient(180deg,transparent 3px,#78716c 3px,#78716c 5px,transparent 5px)}
.fg.resizing,.fg.resizing *{user-select:none!important}
.fg.resizing.col,.fg.resizing.col *{cursor:col-resize!important}
.fg.resizing.row,.fg.resizing.row *{cursor:row-resize!important}
.fg-clip{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0}
.fg-msg{flex:1;display:flex;align-items:center;justify-content:center;gap:.5rem;padding:2rem;color:#78716c}
.fg-spin{width:14px;height:14px;border:2px solid #d6d3d1;border-top-color:#57534e;border-radius:50%;animation:fgspin .8s linear infinite}
@keyframes fgspin{to{transform:rotate(360deg)}}
.fg-pre{flex:1;min-height:0;overflow:auto;margin:0;padding:1rem;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.fg-note{flex:none;padding:.4rem 1rem;color:#78716c;font-size:12px;border-top:1px solid #e7e5e4}
.fg-menu{position:fixed;z-index:50;width:260px;background:#fff;border:1px solid #e7e5e4;border-radius:.5rem;box-shadow:0 8px 24px rgba(28,25,23,.12);font-size:13px;color:#1c1917;padding:4px 0}
.fg-menu .mi{display:block;width:100%;text-align:left;padding:6px 12px;background:none;border:0;font:inherit;color:inherit;cursor:pointer}
.fg-menu .mi:hover{background:#f5f5f4}
.fg-menu hr{border:0;border-top:1px solid #e7e5e4;margin:4px 0}
.fg-menu .mh{padding:6px 12px 4px;font-size:11px;font-weight:600;color:#78716c;text-transform:uppercase;letter-spacing:.04em}
.fg-menu input[type=search]{display:block;width:calc(100% - 24px);margin:0 12px 6px;font:inherit;border:1px solid #d6d3d1;border-radius:.4rem;padding:.3rem .5rem;outline:none;background:#fff;color:inherit}
.fg-menu input[type=search]:focus{border-color:#a8a29e;box-shadow:0 0 0 2px #e7e5e4}
.fg-menu .mb{display:flex;gap:.6rem;padding:0 12px 4px;font-size:12px;color:#78716c}
.fg-menu .mb button{padding:0;border:0;background:none;font:inherit;color:#44403c;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.fg-menu .fl{overflow:auto;padding:0 6px}
.fg-menu label{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:4px;cursor:pointer}
.fg-menu label:hover{background:#f5f5f4}
.fg-menu label span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fg-menu label i{font-style:normal;color:#a8a29e;font-size:11px}
.fg-menu input[type=checkbox]{accent-color:#1c1917;margin:0}
.fg-menu .more{padding:4px 12px;color:#a8a29e;font-size:12px}
.fg-menu .ft{display:flex;justify-content:flex-end;gap:6px;padding:6px 12px 4px}
.fg-menu .ft button{font:inherit;border-radius:.4rem;padding:.3rem .75rem;cursor:pointer;border:1px solid #d6d3d1;background:#fff;color:#44403c}
.fg-menu .ft button.ok{background:#1c1917;border-color:#1c1917;color:#fafaf9}
.fg-menu .ft button.ok:hover{background:#44403c}
.fg-menu .ft .rs{margin-right:auto;border:0;padding-left:0;padding-right:0;text-decoration:underline;text-underline-offset:2px}
`;
