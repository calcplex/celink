// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CalcPlex. Part of celink: https://github.com/calcplex/celink
//
// The feedback box: one text field into a feedback form (core's sendFeedback),
// opened under a question the page asks. What the page knows (the game, the
// answer, the OS) rides in front of the words as a tag; one listener (watch)
// sends every box under its root. A box with a post in flight is marked
// data-busy, and typing in it does not re-enable Send. A preview
// (PREVIEW_HOST) posts nothing: the row goes to the console and the box
// thanks as if it went.
//
//   const { html, parts, watch, failLinkHtml } = feedbackBox({ prefix: 'CE', track: fb => ... });
//
// `form` is the form's address (core's FEEDBACK_FORM unless given), `prefix`
// the tag's first part, and `track(fb)` the page's own count of a box that
// went (its event, its page), called with the box after the post.
//
// failLinkHtml is the quiet link at the foot of a failed connect or send,
// "Tell us what happened": a click opens a box under it ("What happened?")
// tagged "<what> fail: <reason>", counted with the choice "<what>_fail". Its
// address is the form, for a click no script answers. None for an empty
// device list (no_device: its message says what to try) or a TI-84 Evo
// (evo: its message links the Evo page).
import { FEEDBACK_FORM, FEEDBACK_MAX, PREVIEW_HOST, esc, feedbackText, rememberRatingNote, sendFeedback } from './core.mjs';

const shortOs = os => String(os).split('.').slice(0, 3).join('.');
let boxes = 0;
export const TELL_NEVER = ['no_device', 'evo'];

export function feedbackBox({ form = FEEDBACK_FORM, prefix, track = () => {} }) {
  // `note` replaces "deleted: <why>" in the tag, `choice` is the count's
  // choice, `closable` adds an X, `rateKey` keeps the words sent for that
  // vote and `text` starts the box with the words sent last time.
  function html(label, { ask, why = '', os = '', route = '', note = '', choice = '', closable = false, rateKey = '', text = '' }) {
    const id = `ce-fb-${++boxes}`;
    return `<div class="ce-fb" data-game="${esc(label)}" data-why="${esc(why)}" data-os="${esc(os)}" data-route="${esc(route)}" data-note="${esc(note)}" data-choice="${esc(choice)}" data-rate-key="${esc(rateKey)}">`
      + (closable ? '<button type="button" class="ce-fb-close" aria-label="Close">×</button>' : '')
      + `<label for="${id}">${esc(ask)}</label>`
      + `<textarea id="${id}" rows="3" maxlength="${FEEDBACK_MAX}">${esc(text)}</textarea>`
      + `<p class="ce-fb-row"><button type="button" class="ce-fb-send"${text.trim() ? '' : ' disabled'}>Send</button></p></div>`;
  }

  // The tag in front of the words, from the box's own data.
  function parts(fb) {
    const d = fb.dataset;
    return [prefix, d.game, d.note || `deleted: ${d.why}`, d.os && `OS ${shortOs(d.os)}`, d.route, location.pathname, PREVIEW_HOST ? 'PREVIEW' : ''];
  }

  function failLinkHtml(label, { what, reason, os = '', route = '' }) {
    if (TELL_NEVER.includes(reason)) return '';
    return `<p class="ce-fb-tell"><a href="${form}/viewform" target="_blank" rel="noopener" data-game="${esc(label)}" data-note="${esc(`${what} fail: ${reason}`)}" data-choice="${esc(`${what}_fail`)}" data-os="${esc(os)}" data-route="${esc(route)}">Tell us what happened</a></p>`;
  }

  function watch(root) {
    root.addEventListener('input', e => {
      const fb = e.target.closest?.('.ce-fb');
      if (fb) fb.querySelector('.ce-fb-send').disabled = fb.hasAttribute('data-busy') || !e.target.value.trim();
    });
    root.addEventListener('click', async e => {
      const tell = e.target.closest?.('.ce-fb-tell a');
      if (tell) {
        e.preventDefault();
        const d = tell.dataset;
        const line = tell.parentElement;
        line.insertAdjacentHTML('afterend', html(d.game, { ask: 'What happened?', note: d.note, choice: d.choice, os: d.os, route: d.route }));
        line.nextElementSibling.querySelector('textarea').focus();
        line.remove();
        return;
      }
      const go = e.target.closest?.('.ce-fb-send');
      if (!go) return;
      const fb = go.closest('.ce-fb');
      const text = fb.querySelector('textarea').value.trim();
      if (!text || fb.hasAttribute('data-busy')) return;
      fb.setAttribute('data-busy', '1');
      go.disabled = true;
      fb.querySelector('.ce-fb-err')?.remove();
      try {
        if (PREVIEW_HOST) console.info('[not sent: preview]', 'feedback', feedbackText(text, parts(fb)));
        else await sendFeedback(text, parts(fb), undefined, form);
        fb.removeAttribute('data-busy');
        if (fb.dataset.rateKey) rememberRatingNote(fb.dataset.rateKey, text);
        fb.innerHTML = '<p class="ce-fb-done">Thank you! We read every response and will do our best to improve.</p>';
        track(fb);
      } catch {
        fb.removeAttribute('data-busy');
        go.disabled = false;
        go.closest('.ce-fb-row').insertAdjacentHTML('afterend', `<p class="ce-fb-err">That didn't send. Try again, or <a href="${form}/viewform" target="_blank" rel="noopener">open the form</a>.</p>`);
      }
    });
  }

  return { html, parts, watch, failLinkHtml };
}
