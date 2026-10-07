import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const siteUrl = "http://127.0.0.1:4173/";
const port = 9227;
const profileDir = join(tmpdir(), `svet-qa-${Date.now()}`);
const screenshotsDir = resolve("screenshots");

mkdirSync(profileDir, { recursive: true });
mkdirSync(screenshotsDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitForDebugger() {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

await waitForDebugger();

const pageResponse = await fetch(
  `http://127.0.0.1:${port}/json/new?${encodeURIComponent(siteUrl)}`,
  { method: "PUT" }
);
const page = await pageResponse.json();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
});

let commandId = 0;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve: resolveCommand, reject: rejectCommand } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) rejectCommand(new Error(message.error.message));
  else resolveCommand(message.result);
});

function send(method, params = {}) {
  commandId += 1;
  const id = commandId;
  const promise = new Promise((resolveCommand, rejectCommand) => {
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

async function setViewport(width, height = 900) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600
  });
  await send("Page.navigate", { url: siteUrl });
  await delay(900);
  await evaluate("document.fonts.ready");
  await evaluate(`(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((image) => { image.loading = 'eager'; });
    await Promise.all([...document.images].map((image) => {
      if (image.complete) return image.decode().catch(() => undefined);
      return new Promise((resolveImage) => {
        image.addEventListener('load', resolveImage, { once: true });
        image.addEventListener('error', resolveImage, { once: true });
      });
    }));
  })()`);
}

async function getLayoutCheck(width) {
  await setViewport(width);
  return evaluate(`(() => {
    const root = document.documentElement;
    const overflowing = [...document.querySelectorAll('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.position !== 'fixed' && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .slice(0, 8)
      .map((element) => ({ tag: element.tagName, className: element.className, rect: element.getBoundingClientRect().toJSON() }));
    return {
      width: innerWidth,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      horizontalOverflow: root.scrollWidth > root.clientWidth,
      overflowing,
      imageFailures: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src),
      headingCount: document.querySelectorAll('h1').length,
      missingAnchors: [...document.querySelectorAll('a[href^="#"]')]
        .map((link) => link.getAttribute('href'))
        .filter((href) => href !== '#' && !document.querySelector(href)),
      externalLinkCount: document.querySelectorAll('a[target="_blank"]').length,
      videoSources: [...document.querySelectorAll('video source')].map((source) => source.src)
    };
  })()`);
}

const checks = [];
for (const width of [320, 470, 768, 900, 1024, 1100, 1280]) {
  checks.push(await getLayoutCheck(width));
}

await setViewport(320);
const resilience = await evaluate(`(async () => {
  const root = document.documentElement;
  const paragraph = document.querySelector('.stage-card__content p');
  const originalText = paragraph.textContent;
  const originalFontSize = root.style.fontSize;
  paragraph.textContent = [originalText, originalText, originalText].join(' ');
  root.style.fontSize = '200%';
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const result = {
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    horizontalOverflow: root.scrollWidth > root.clientWidth,
    paragraphHeight: Math.round(paragraph.getBoundingClientRect().height),
    overflowing: [...document.querySelectorAll('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      })
      .slice(0, 8)
      .map((element) => ({ tag: element.tagName, className: element.className, right: Math.round(element.getBoundingClientRect().right) })),
    internallyOverflowing: [...document.querySelectorAll('body *')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        text: element.textContent.trim().slice(0, 60)
      }))
  };
  paragraph.textContent = originalText;
  root.style.fontSize = originalFontSize;
  return result;
})()`);

await setViewport(768);
const interaction = await evaluate(`(() => {
  const button = document.querySelector('[data-note-next]');
  const text = document.querySelector('[data-note-text]');
  const counter = document.querySelector('[data-note-counter]');
  const states = [{ text: text.textContent.trim(), counter: counter.textContent }];
  for (let index = 0; index < 6; index += 1) {
    button.click();
    states.push({ text: text.textContent.trim(), counter: counter.textContent });
  }
  return {
    states,
    uniqueNotes: new Set(states.slice(0, 6).map((state) => state.text)).size,
    returnedToFirst: states[0].text === states[6].text,
    liveRegion: text.getAttribute('aria-live'),
    buttonTag: button.tagName
  };
})()`);

const mediaCheck = await evaluate(`(async () => {
  const videos = [...document.querySelectorAll('video')];
  await Promise.all(videos.map((video) => new Promise((resolveVideo) => {
    if (video.readyState >= 1) {
      resolveVideo();
      return;
    }
    const finish = () => resolveVideo();
    video.addEventListener('loadedmetadata', finish, { once: true });
    video.addEventListener('error', finish, { once: true });
    video.load();
    setTimeout(finish, 6000);
  })));
  return videos.map((video) => ({
    readyState: video.readyState,
    duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
    error: video.error ? video.error.code : null,
    controls: video.controls,
    autoplay: video.autoplay
  }));
})()`);

for (const width of [320, 768, 1024, 1280]) {
  await setViewport(width);
  const metrics = await send("Page.getLayoutMetrics");
  const contentHeight = Math.ceil(metrics.cssContentSize.height);
  const screenshot = await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width,
      height: Math.min(contentHeight, 30000),
      scale: 1
    }
  });
  writeFileSync(join(screenshotsDir, `site-${width}.png`), Buffer.from(screenshot.data, "base64"));
}

const report = { checks, resilience, interaction, mediaCheck };
writeFileSync(resolve("screenshots", "qa-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

socket.close();
chrome.kill();
await delay(250);
try {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
} catch {
  // The operating system may release the temporary browser profile later.
}
