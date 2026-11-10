// Deterministic media, not a mock of the login controller. Preload Audio instances
// stay separate from React's playback element, so loading can never unlock autoplay.
export async function installPiMediaFixture(piContext, piOptions = {}) {
  await piContext.addInitScript((piOptions) => {
    const {
      piPreload = "ready", piAutoplay = true, piIgnoreStartGesture = false,
      piAutoEnd = false, piManualVoices = [], piPlayDelays = {}, piRejectPlay = false,
    } = piOptions;
    const piPlaying = new WeakSet();
    const piEnded = new WeakMap();
    const piState = window.piMediaFixture = {
      preloads: [], calls: [], pauses: [], events: [], allowed: piAutoplay, hidden: false,
    };
    const piVoice = (piAudio) => new URL(piAudio.src || "/", location.href).pathname;
    const piEmit = (piAudio, piType) => {
      piState.events.push({ type: piType, source: piVoice(piAudio), at: performance.now() });
      piAudio.dispatchEvent(new Event(piType));
    };
    const piFinish = (piAudio) => {
      piPlaying.delete(piAudio);
      piEnded.set(piAudio, piAudio.src);
      piEmit(piAudio, "ended");
    };
    piState.finish = () => piFinish(document.querySelector("audio"));
    piState.releasePreload = (piIndex, piType = "canplaythrough") => piState.preloads[piIndex].piReleasePreload(piType);
    const piNativeAudio = window.Audio;
    window.Audio = function (piSource) {
      const piAudio = new piNativeAudio();
      let piUrl = piSource ? new URL(piSource, location.href).href : "";
      // Avoid real network completion racing the manually controlled loading gate.
      Object.defineProperty(piAudio, "src", {
        configurable: true, get: () => piUrl,
        set: (piValue) => { piUrl = new URL(piValue, location.href).href; },
      });
      piAudio.piReady = 0;
      Object.defineProperty(piAudio, "readyState", { configurable: true, get: () => piAudio.piReady });
      piAudio.piReleasePreload = (piType) => {
        if (!piUrl) return;
        piAudio.piReady = piType === "canplaythrough" ? 4 : 0;
        piAudio.dispatchEvent(new Event(piType));
      };
      const piRemoveAttribute = piAudio.removeAttribute.bind(piAudio);
      piAudio.removeAttribute = (piName) => {
        if (piName === "src") {
          piUrl = "";
          // Strict-mode effect replay aborts the first six instances. Only live
          // preload instances participate in the manually released gate.
          const piIndex = piState.preloads.indexOf(piAudio);
          if (piIndex >= 0) piState.preloads.splice(piIndex, 1);
        }
        piRemoveAttribute(piName);
      };
      piState.preloads.push(piAudio);
      if (piPreload !== "manual") setTimeout(() => piAudio.piReleasePreload(
        piPreload === "error" ? "error" : "canplaythrough"), 0);
      return piAudio;
    };
    window.Audio.prototype = piNativeAudio.prototype;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => piState.hidden });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return !piPlaying.has(this); } });
    Object.defineProperty(HTMLMediaElement.prototype, "ended", { configurable: true, get() { return piEnded.get(this) === this.src; } });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get: () => 30 });
    HTMLMediaElement.prototype.load = function () {};
    HTMLMediaElement.prototype.pause = function () {
      const piWasPlaying = piPlaying.has(this);
      piPlaying.delete(this);
      piState.pauses.push({ source: piVoice(this), at: performance.now() });
      if (piWasPlaying) piEmit(this, "pause");
    };
    HTMLMediaElement.prototype.play = function () {
      const piEvent = window.event;
      const piGesture = piEvent?.isTrusted && ["click", "pointerup", "touchend", "keydown"].includes(piEvent.type);
      const piStartGesture = piEvent?.target instanceof Element && piEvent.target.closest("[data-pi-start]");
      // React may flush a password effect before the start event unwinds. In the
      // blocked-autoplay fixture that mandatory start is not an audio retry.
      const piAudioGesture = piGesture && !(piIgnoreStartGesture && piStartGesture);
      const piSource = piVoice(this);
      const piCall = { source: piSource, gesture: piAudioGesture ? piEvent.type : null, at: performance.now(), pending: false };
      piState.calls.push(piCall);
      if (piRejectPlay || (!piState.allowed && !piAudioGesture)) {
        return Promise.reject(new DOMException("Autoplay blocked", "NotAllowedError"));
      }
      piState.allowed = true;
      piEnded.delete(this);
      // Native play() changes paused immediately, even while its promise is
      // pending on loading. Delay playing, not the active/paused semantics.
      const piSourceUrl = this.src;
      piCall.pending = true;
      piPlaying.add(this);
      const piBegin = () => {
        piCall.pending = false;
        if (this.src !== piSourceUrl || !piPlaying.has(this)) return;
        piEmit(this, "play");
        piEmit(this, "playing");
        if (piAutoEnd && !piManualVoices.some((piName) => piSource.endsWith(`/pi-${piName}.mp3`))) {
          setTimeout(() => { if (this.src.endsWith(piSource) && piPlaying.has(this)) piFinish(this); }, 40);
        }
      };
      const piDelay = Object.entries(piPlayDelays).find(([piName]) => piSource.endsWith(`/pi-${piName}.mp3`))?.[1] || 0;
      if (!piDelay) { piBegin(); return Promise.resolve(); }
      return new Promise((piResolve) => setTimeout(() => { piBegin(); piResolve(); }, piDelay));
    };
  }, piOptions);
}

export const piVoicePaths = ["connected", "permission", "password", "read", "verified", "welcome"]
  .map((piName) => `/login2/assets/pi-${piName}.mp3`);
