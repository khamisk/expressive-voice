/**
 * Browser-skill QA helpers. Pass an already-authorized in-app Browser tab.
 * No browser launch, direct provider calls, hidden app state, or filesystem I/O.
 * Run ONE bounded case per tool invocation and persist its return before the
 * next case, so a tooling timeout cannot erase an entire verification pass.
 */
export async function captureVoiceFrame(tab) {
  return tab.playwright.evaluate(() => {
    const actor = document.querySelector('[data-performance]');
    const audio = document.querySelector('audio');
    const input = document.querySelector('[data-input-state]');
    const caption = document.querySelector('[data-caption-window]');
    return {
      status: document.querySelector('[role="status"].sr-only')?.textContent,
      inputState: input?.getAttribute('data-input-state'),
      handoff: input?.getAttribute('data-handoff'),
      inputRms: Number(audio?.dataset.inputRms || 0),
      outputRms: Number(audio?.dataset.outputRms || 0),
      localTurn: audio?.dataset.localTurnState,
      inputMode: audio?.dataset.inputMode,
      meterTime: Number(audio?.dataset.meterTime || 0),
      caption: caption?.textContent || '',
      captionWindow: caption?.getAttribute('data-caption-window'),
      words: [...document.querySelectorAll('[data-caption-current="true"] [data-word-index]')]
        .map(node => ({ index: Number(node.getAttribute('data-word-index')), text: node.textContent })),
      character: actor ? Object.fromEntries([...actor.attributes].filter(attr => attr.name.startsWith('data-'))
        .map(attr => [attr.name, attr.value])) : null,
      cue: JSON.parse(document.querySelector('[data-current-cue]')?.getAttribute('data-current-cue') || 'null'),
      transport: JSON.parse(document.querySelector('[data-transport]')?.getAttribute('data-transport') || '[]')
        .filter(event => !['input_audio_buffer.clear', 'input_audio_buffer.cleared'].includes(event.type)),
      diagnostics: JSON.parse(document.querySelector('[data-diagnostics]')?.getAttribute('data-diagnostics') || '[]'),
      userTranscript: document.querySelector('[data-user-transcript]')?.getAttribute('data-user-transcript'),
      presentedTranscript: document.querySelector('[data-presented-transcript]')?.getAttribute('data-presented-transcript'),
      error: document.querySelector('[role="alert"]')?.textContent || null,
    };
  });
}

const waitForNextSample = () => new Promise(resolve => setTimeout(resolve, 55));

function summarize(run) {
  const words = new Map();
  const events = new Map();
  const diagnostics = new Map();
  const cues = new Map();
  for (const frame of run.frames) {
    if (run.firstAudibleAt !== undefined && frame.t >= run.firstAudibleAt) {
      for (const word of frame.words) words.set(word.index, word.text.trim());
    }
    if (frame.status?.endsWith('speaking')) {
      if (frame.cue && !cues.has(frame.cue.id)) cues.set(frame.cue.id, { ...frame.cue, atMs: frame.t });
    }
    for (const event of frame.transport) {
      if (event.atMs >= run.startMeter) events.set(JSON.stringify(event), event);
    }
    for (const event of frame.diagnostics) diagnostics.set(JSON.stringify(event), event);
    delete frame.transport;
    delete frame.diagnostics;
  }
  run.events = [...events.values()];
  run.diagnostics = [...diagnostics.values()];
  run.cues = [...cues.values()];
  run.reconstructedCaption = [...words.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join(' ');
  run.sampledWordCount = words.size;
  run.firstSpeechCueAt = run.frames.find(frame => frame.cue?.source === 'assistant' && frame.status?.endsWith('speaking'))?.t ?? null;
  run.cueLagMs = run.firstSpeechCueAt === null || run.firstAudibleAt === undefined ? null : run.firstSpeechCueAt - run.firstAudibleAt;
  run.lastAudibleAt = run.frames.filter(frame => frame.outputRms > 0.005).at(-1)?.t;
  run.effects = [...new Set(run.frames.map(frame => frame.character?.['data-effect']).filter(effect => effect && effect !== 'none'))];
  run.finalUserTranscript = run.frames.at(-1)?.userTranscript;
  run.finalPresentedTranscript = run.frames.at(-1)?.presentedTranscript ?? null;
  run.summary = {
    name: run.name, completed: run.completed, reply: run.reconstructedCaption,
    sampledWordCount: run.sampledWordCount, firstAudibleAt: run.firstAudibleAt,
    cueLagMs: run.cueLagMs, effects: run.effects,
    cues: run.cues.map(cue => ({ expression: cue.expression, intent: cue.intent, source: cue.source, anchor: cue.anchor })),
    error: run.frames.at(-1)?.error,
  };
  return run;
}

export async function runPhraseCase(tab, name, prompt, options = {}) {
  const before = await captureVoiceFrame(tab);
  const run = { name, prompt, startedAt: new Date().toISOString(), startMeter: before.meterTime, frames: [], completed: false };
  const started = Date.now();
  await tab.playwright.getByRole('textbox', { name: 'Live test · typed input, real voice' }).fill(prompt);
  await tab.playwright.getByRole('button', { name: 'Send', exact: true }).click();
  let quietSince = null;
  let captured = false;
  while (Date.now() - started < 18_000) {
    const frame = await captureVoiceFrame(tab);
    frame.t = Date.now() - started;
    run.frames.push(frame);
    if (frame.outputRms > 0.005) run.firstAudibleAt ??= frame.t;
    if (!captured && options.onSpeakingFrame && run.firstAudibleAt !== undefined && frame.t - run.firstAudibleAt >= 600) {
      captured = true;
      await options.onSpeakingFrame(frame);
    }
    if (run.firstAudibleAt !== undefined && frame.status?.endsWith('listening') && frame.outputRms < 0.001) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince > 450) { run.completed = true; break; }
    } else quietSince = null;
    if (frame.error) break;
    await waitForNextSample();
  }
  if (!run.completed && !run.frames.at(-1)?.error) {
    run.safetyStopped = true;
    await tab.playwright.getByRole('button', { name: 'End conversation', exact: true }).click();
  }
  return summarize(run);
}

export async function runOverlapCase(tab, name, initialPrompt, fixture, expectedResponses) {
  const before = await captureVoiceFrame(tab);
  const run = { name, initialPrompt, fixture, startedAt: new Date().toISOString(), startMeter: before.meterTime, frames: [], completed: false, injectedAt: null };
  const started = Date.now();
  await tab.playwright.getByRole('textbox', { name: 'Live test · typed input, real voice' }).fill(initialPrompt);
  await tab.playwright.getByRole('button', { name: 'Send', exact: true }).click();
  let quietSince = null;
  while (Date.now() - started < 28_000) {
    const frame = await captureVoiceFrame(tab);
    frame.t = Date.now() - started;
    run.frames.push(frame);
    if (frame.outputRms > 0.005) run.firstAudibleAt ??= frame.t;
    if (run.firstAudibleAt !== undefined && run.injectedAt === null && frame.t - run.firstAudibleAt > 500 && frame.inputState === 'idle') {
      await tab.playwright.getByRole('button', { name: fixture, exact: true }).click();
      run.injectedAt = Date.now() - started;
    }
    const responseCount = frame.transport.filter(event => event.type === 'response.created' && event.atMs >= run.startMeter).length;
    if (run.injectedAt !== null && frame.t - run.injectedAt > 6500 && responseCount >= expectedResponses
      && frame.status?.endsWith('listening') && frame.outputRms < 0.001 && frame.localTurn === 'quiet') {
      quietSince ??= Date.now();
      if (Date.now() - quietSince > 450) { run.completed = true; break; }
    } else quietSince = null;
    if (frame.error) break;
    await waitForNextSample();
  }
  if (!run.completed && !run.frames.at(-1)?.error) {
    run.safetyStopped = true;
    await tab.playwright.getByRole('button', { name: 'End conversation', exact: true }).click();
  }
  return summarize(run);
}
