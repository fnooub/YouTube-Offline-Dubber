// ==UserScript==
// @name         YouTube Offline Dubber
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Lồng tiếng video YouTube 100% offline trên cả máy tính và điện thoại di động (Hỗ trợ Trusted Types).
// @author       Antigravity
// @match        https://*.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // --- 1. TRUSTED TYPES SYSTEM BYPASS/COMPATIBILITY ---
  let htmlPolicy = null;
  let scriptPolicy = null;

  function getHTMLPolicy() {
    if (htmlPolicy) return htmlPolicy;
    if (!window.trustedTypes || !window.trustedTypes.createPolicy) return null;
    const policyNames = ["youtube-offline-dubber-html", "youtube-pol", "default"];
    for (const name of policyNames) {
      try {
        htmlPolicy = window.trustedTypes.createPolicy(name, {
          createHTML: (html) => html
        });

        return htmlPolicy;
      } catch (e) { }
    }
    return null;
  }

  function getScriptPolicy() {
    if (scriptPolicy) return scriptPolicy;
    if (!window.trustedTypes || !window.trustedTypes.createPolicy) return null;
    const policyNames = ["youtube-offline-dubber-script", "youtube-pol", "default"];
    for (const name of policyNames) {
      try {
        scriptPolicy = window.trustedTypes.createPolicy(name, {
          createScript: (script) => script
        });

        return scriptPolicy;
      } catch (e) { }
    }
    return null;
  }

  function setInnerHTMLSafe(element, htmlString) {
    try {
      const policy = getHTMLPolicy();
      if (policy) {
        element.innerHTML = policy.createHTML(htmlString);
        return;
      }
    } catch (e) { }

    // Fallback: Sử dụng DOMParser không kích hoạt kiểm tra Trusted Types trong Chromium
    try {
      const parser = new DOMParser();
      const parsedDoc = parser.parseFromString(htmlString, "text/html");
      element.textContent = "";
      const body = parsedDoc.body;
      while (body.firstChild) {
        element.appendChild(body.firstChild);
      }
    } catch (e) {

    }
  }

  // --- 2. HOOK MẠNG ĐỂ LẤY PHỤ ĐỀ YOUTUBE (AN TOÀN CSP) ---
  (function initNetworkHooks() {
    const targetWins = [window];
    if (typeof unsafeWindow !== "undefined" && unsafeWindow !== window) {
      targetWins.push(unsafeWindow);
    }

    function isTimedtextUrl(url) {
      try {
        const urlStr = typeof url === "string" ? url : (url?.url || "");
        return !!urlStr && urlStr.includes("youtube.com/api/timedtext");
      } catch (e) {
        return false;
      }
    }

    function sendSubtitles(url, bodyText) {
      try {
        if (!url || !bodyText) return;
        let parsedData = typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText;
        window.postMessage({
          type: "YT_OFFLINE_SUBTITLES",
          url: url,
          data: parsedData
        }, "*");
      } catch (err) { }
    }

    targetWins.forEach(win => {
      try {
        // Hook XMLHttpRequest
        if (win.XMLHttpRequest && !win.XMLHttpRequest.prototype.__dubberHooked) {
          win.XMLHttpRequest.prototype.__dubberHooked = true;
          const origOpen = win.XMLHttpRequest.prototype.open;
          const origSend = win.XMLHttpRequest.prototype.send;

          win.XMLHttpRequest.prototype.open = function (method, url, ...args) {
            this.__timedtextUrl = url;
            return origOpen.call(this, method, url, ...args);
          };

          win.XMLHttpRequest.prototype.send = function (...args) {
            try {
              const url = this.__timedtextUrl;
              if (isTimedtextUrl(url) && !this.__hookedForDubbing) {
                this.__hookedForDubbing = true;
                this.addEventListener("load", () => {
                  try { sendSubtitles(url, this.responseText); } catch (e) { }
                });
              }
            } catch (e) { }
            return origSend.apply(this, args);
          };
        }

        // Hook fetch
        if (win.fetch && !win.fetch.__dubberHooked) {
          const origFetch = win.fetch;
          win.fetch = async function (...args) {
            const response = await origFetch.apply(this, args);
            try {
              const requestUrl = args[0];
              const urlString = typeof requestUrl === "string" ? requestUrl : requestUrl?.url || "";
              if (isTimedtextUrl(urlString)) {
                const cloned = response.clone();
                cloned.text().then(text => sendSubtitles(urlString, text)).catch(() => { });
              }
            } catch (e) { }
            return response;
          };
          win.fetch.__dubberHooked = true;
        }
      } catch (e) { }
    });
  })();

  // --- 3. CÁC BIẾN TRẠNG THÁI CORE LOGIC ---
  let videoElement = null;
  let rawSubtitles = null;
  let activeTranscript = [];
  let currentSegmentIndex = -1;
  let isDubbingActive = false;
  let originalVolume = null;
  let isVolumeDucked = false;
  let ttsTimer = null;
  let checkSubtitlesTimeout = null;
  let toastTimeout = null;
  let currentVideoId = null;

  // Cấu hình tải từ GM Storage
  let selectedVoiceName = "auto";
  let duckVolumeLevel = 15;
  let voiceVolumeLevel = 100;
  let ttsSpeedLevel = 1.35;

  function loadSettings() {
    if (typeof GM_getValue !== "undefined") {
      selectedVoiceName = GM_getValue("voiceName", "auto");
      duckVolumeLevel = GM_getValue("duckVolume", 15);
      voiceVolumeLevel = GM_getValue("voiceVolume", 100);
      ttsSpeedLevel = GM_getValue("ttsSpeed", 1.35);
    }
  }
  loadSettings();

  // 1. Hàm làm sạch phụ đề (lọc bỏ các thẻ rác [...], (...), xóa sạch \\n, chuẩn hóa khoảng trắng quanh dấu chấm phẩy)
  function cleanSubtitleText(text) {
    if (!text) return "";
    return text
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^\)]*\)/g, "")
      .replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ")
      .replace(/\\[rn]/g, " ")
      .replace(/\s*([.!?…,;:–—])\s*/g, "$1 ") // Dọn dẹp khoảng trắng dư thừa trước dấu chấm/phẩy ("sức . Nếu" -> "sức. Nếu")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Kiểm tra xem đoạn văn có kết thúc bằng dấu ngắt câu (. ! ? …) không (loại trừ số thập phân & từ viết tắt)
  // Kiểm tra xem đoạn văn có kết thúc bằng BẤT KỲ dấu câu nào (. ! ? … , ; : – —) không (loại trừ số thập phân & từ viết tắt)
  function isPunctuationEnded(text) {
    if (!text) return false;
    const trimmed = text.trim();

    // Tất cả các dấu ngắt vế/câu thông thường (phẩy, hỏi, cảm, chấm phẩy, gạch ngang...)
    if (/[!?…,:;–—]\s*$/.test(trimmed)) return true;

    // Kiểm tra dấu chấm .
    if (/\.\s*$/.test(trimmed)) {
      // Tránh ngắt ở số thập phân hoặc danh sách đánh số (ví dụ: "1.5", "1.1", "1.")
      if (/\d\.\d?$/i.test(trimmed)) return false;

      // Tránh ngắt ở các từ viết tắt phổ biến (ví dụ: "v.v.", "dr.", "mr.", "tp.", "th.s")
      if (/(?:v\.v|dr|mr|mrs|ms|prof|vs|tp|th\.s|p\.s)\.$/i.test(trimmed)) return false;

      return true;
    }

    return false;
  }

  // 2. Tách nhỏ các dòng phụ đề bị dính nhiều câu/vế ở giữa thành các micro-tokens chuẩn mốc thời gian
  function flattenAndSplitTranscript(rawTranscript) {
    const tokens = [];

    for (const item of rawTranscript) {
      const cleaned = cleanSubtitleText(item.text);
      if (!cleaned) continue;

      // Tách theo BẤT KỲ dấu câu nào (. ! ? … , ; : – —) có khoảng trắng đằng sau
      const parts = cleaned.split(/(?<=[.!?…,;:–—])\s+/);

      if (parts.length === 1) {
        tokens.push({
          start: item.start,
          duration: item.duration || 0,
          text: parts[0]
        });
      } else {
        const totalLen = cleaned.length || 1;
        let currentStart = item.start;

        for (let p = 0; p < parts.length; p++) {
          const partText = parts[p].trim();
          if (!partText) continue;

          const partRatio = partText.length / totalLen;
          const partDuration = Math.round((item.duration || 2000) * partRatio);

          tokens.push({
            start: currentStart,
            duration: partDuration,
            text: partText
          });
          currentStart += partDuration;
        }
      }
    }
    return tokens;
  }

  // 3. Gom micro-tokens thành các cụm câu hoàn chỉnh (ưu tiên mốc 6 đến 10 giây)
  function mergeSubtitles(rawTranscript) {
    if (!Array.isArray(rawTranscript) || rawTranscript.length === 0) return [];

    const tokens = flattenAndSplitTranscript(rawTranscript);
    if (tokens.length === 0) return [];

    const merged = [];
    let current = null;

    const TARGET_DURATION = 6000;  // Mốc ưu tiên tối thiểu 6 giây để ngắt ở bất kỳ dấu câu nào
    const MAX_DURATION = 10000;    // Mốc tối đa tuyệt đối 10 giây
    const MAX_GAP = 1200;          // Khoảng nghỉ giữa 2 câu > 1.2s

    for (let i = 0; i < tokens.length; i++) {
      const item = tokens[i];
      if (!item.text) continue;

      if (!current) {
        current = {
          start: item.start,
          duration: item.duration || 0,
          text: item.text
        };
      } else {
        const currentEnd = current.start + (current.duration || 2000);
        const gap = item.start - currentEnd;
        const proposedEnd = item.duration > 0 ? item.start + item.duration : item.start + 2500;
        const proposedDuration = proposedEnd - current.start;

        const hasPunct = isPunctuationEnded(current.text);

        // Quy tắc ngắt cụm chuẩn yêu cầu mốc 6s đến 10s:
        // 1. Đã đạt từ 6s trở lên (>= 6000ms) VÀ kết thúc bằng BẤT KỲ dấu câu nào (. ! ? … , ; : – —)
        // 2. Thời lượng tích dồn đề xuất vượt quá mốc tối đa 10s (MAX_DURATION)
        // 3. Khoảng lặng giữa 2 đoạn thoại quá dài (> 1.2s)
        const isReachedTargetPunct = (current.duration >= TARGET_DURATION) && hasPunct;
        const stopOverflow = proposedDuration > MAX_DURATION;
        const stopGap = gap > MAX_GAP;

        if (isReachedTargetPunct || stopOverflow || stopGap) {
          merged.push(current);
          current = {
            start: item.start,
            duration: item.duration || 0,
            text: item.text
          };
        } else {
          current.text += " " + item.text;
          current.duration = proposedEnd - current.start;
        }
      }
    }

    if (current) merged.push(current);

    return merged;
  }

  // Phân tích phụ đề JSON3 từ YouTube
  function parseSubtitles(data) {
    if (!data || !Array.isArray(data.events)) {
      return [];
    }

    const transcript = [];
    for (const event of data.events) {
      if (!event.segs || !Array.isArray(event.segs)) continue;
      const text = event.segs.map(s => s.utf8 || "").join("").trim();
      const cleaned = cleanSubtitleText(text);

      if (cleaned.length > 0) {
        transcript.push({
          start: event.tStartMs || 0,
          duration: event.dDurationMs || 0,
          text: cleaned
        });
      }
    }

    return mergeSubtitles(transcript);
  }

  // --- 5. ĐIỀU KHIỂN ÂM LƯỢNG (AUDIO DUCKING) ---
  function duckVolume() {
    if (!videoElement || isVolumeDucked) return;
    originalVolume = videoElement.volume;
    videoElement.volume = originalVolume * (duckVolumeLevel / 100);
    isVolumeDucked = true;

  }

  function unduckVolume() {
    if (!videoElement || !isVolumeDucked) return;
    if (originalVolume !== null) {
      videoElement.volume = originalVolume;
    }
    isVolumeDucked = false;

  }

  // --- 6. ENGINE TTS (WEB SPEECH API) ---
  function stopSpeaking() {
    window.speechSynthesis.cancel();
    if (ttsTimer) {
      clearInterval(ttsTimer);
      ttsTimer = null;
    }
  }

  let baseVideoSpeed = 1.0;

  function speakText(text, durationMs, segmentIndex = -1, forceClear = false) {
    const cleanedText = cleanSubtitleText(text);
    if (!cleanedText || !isDubbingActive) return;

    // Ngắt cưỡng bức khi Tua video, Đổi video hoặc bị trễ quá xa
    if (forceClear) {
      stopSpeaking();
    }

    // Đảm bảo âm lượng video luôn duy trì ở mức giảm (15%) khi bật lồng tiếng
    duckVolume();

    const utterance = new SpeechSynthesisUtterance(cleanedText);
    utterance.volume = voiceVolumeLevel / 100;

    // Tốc độ đọc TTS mặc định 1.35x (có thể tùy chỉnh trong Cài đặt từ 0.5x - 3.0x)
    const currentRate = parseFloat(ttsSpeedLevel) || 1.35;
    utterance.rate = currentRate * (videoElement?.playbackRate || 1.0);

    // Handler khôi phục trạng thái video khi phát xong câu
    utterance.onstart = () => {
      duckVolume();
    };

    utterance.onend = () => {
      // Khi đọc xong câu thoại, kiểm tra xem video đã chuyển sang cảnh/đoạn mới chưa để tiếp nối mượt mà
      if (isDubbingActive && videoElement && !videoElement.paused) {
        setTimeout(handleTimeUpdate, 50);
      }
    };

    utterance.onerror = (e) => {

    };

    // Tìm giọng đọc thích hợp
    const voices = window.speechSynthesis.getVoices();
    let chosenVoice = null;

    if (selectedVoiceName !== "auto") {
      chosenVoice = voices.find(v => v.name === selectedVoiceName);
    }

    if (!chosenVoice) {
      chosenVoice = voices.find(v =>
        v.lang.toLowerCase().startsWith("vi") ||
        v.lang.toLowerCase().includes("vi") ||
        v.name.toLowerCase().includes("vi")
      );
    }

    if (chosenVoice) {
      utterance.voice = chosenVoice;
      utterance.lang = chosenVoice.lang;
    } else {
      utterance.lang = "vi-VN";
    }

    window.speechSynthesis.speak(utterance);

    if (!ttsTimer) {
      ttsTimer = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        } else {
          clearInterval(ttsTimer);
          ttsTimer = null;
        }
      }, 7000);
    }
  }

  function findActiveSegmentIndex(currentTimeMs) {
    if (!activeTranscript.length) return -1;
    return activeTranscript.findIndex(seg =>
      currentTimeMs >= seg.start && currentTimeMs < (seg.start + seg.duration + 300)
    );
  }

  function showToastMessage(text) {
    let existingToast = document.querySelector(".offline-dubber-toast");
    if (existingToast) existingToast.remove();
    if (toastTimeout) clearTimeout(toastTimeout);

    const toast = document.createElement("div");
    toast.className = "offline-dubber-toast";

    setInnerHTMLSafe(toast, `
      <div style="display:flex; align-items:center; gap:8px;">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="#ff0055" style="flex-shrink:0;">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
        <span style="line-height: 1.4;">${text}</span>
      </div>
    `);

    Object.assign(toast.style, {
      position: "absolute",
      bottom: "80px",
      right: "24px",
      background: "rgba(15, 12, 32, 0.95)",
      border: "1px solid rgba(255, 255, 255, 0.1)",
      borderRadius: "10px",
      padding: "12px 16px",
      color: "#f3f0ff",
      fontSize: "13px",
      boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
      backdropFilter: "blur(8px)",
      zIndex: "99999",
      maxWidth: "300px",
      opacity: "0",
      transform: "translateY(10px)",
      transition: "opacity 0.3s ease, transform 0.3s ease",
      pointerEvents: "none"
    });

    const container = document.querySelector(".html5-video-player");
    if (container) {
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
      }, 100);

      toastTimeout = setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(10px)";
        setTimeout(() => toast.remove(), 300);
      }, 7000);
    }
  }

  function handleTimeUpdate() {
    if (!isDubbingActive || !videoElement) return;

    const currentTimeMs = videoElement.currentTime * 1000;
    const activeIndex = findActiveSegmentIndex(currentTimeMs);

    if (activeIndex !== -1 && activeIndex !== currentSegmentIndex) {
      const seg = activeTranscript[activeIndex];
      const isTooFarBehind = (currentTimeMs - seg.start > 3000);

      // Nếu câu trước đang đọc dở và chưa bị trễ quá xa (<= 3s): cho phép đọc hết câu mượt mà, không cắt ngang giữa chừng
      if (window.speechSynthesis.speaking && !isTooFarBehind) {
        return;
      }

      // Chỉ cắt ngang câu cũ khi bị trễ tiến độ quá 3 giây (ví dụ tua video)
      if (isTooFarBehind) {
        stopSpeaking();
      }

      currentSegmentIndex = activeIndex;

      speakText(seg.text, seg.duration, activeIndex, false);
    }
  }

  function triggerSubtitlesIfNeeded() {
    const ccBtn = document.querySelector("button.ytp-subtitles-button");
    if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {

      ccBtn.click();
    }
  }

  function initVideoTracking() {
    const video = document.querySelector("#movie_player video.html5-main-video") ||
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video");

    if (video && video !== videoElement) {
      if (videoElement) {
        videoElement.removeEventListener("timeupdate", handleTimeUpdate);
        videoElement.removeEventListener("seeking", stopSpeaking);
        videoElement.removeEventListener("pause", stopSpeaking);
      }
      videoElement = video;
      videoElement.addEventListener("timeupdate", handleTimeUpdate);
      videoElement.addEventListener("seeking", () => {
        currentSegmentIndex = -1;
        stopSpeaking();
      });
      videoElement.addEventListener("pause", stopSpeaking);

      if (isDubbingActive) {
        isVolumeDucked = false;
        originalVolume = null;
        duckVolume();
        triggerSubtitlesIfNeeded();
      }

    }
  }

  // Nhận phụ đề được post từ hook script chính (Sử dụng unsafeWindow để nhận sự kiện từ MAIN world)
  const winForMessage = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  winForMessage.addEventListener("message", (event) => {
    if (event.data?.type !== "YT_OFFLINE_SUBTITLES") return;

    rawSubtitles = event.data.data;
    activeTranscript = parseSubtitles(rawSubtitles);
    currentSegmentIndex = -1;
    stopSpeaking();
  });

  // Kiểm tra đổi video (Single Page Application của YouTube)
  function checkVideoIdChange() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const videoId = urlParams.get("v");
      if (videoId !== currentVideoId) {
        currentVideoId = videoId;

        rawSubtitles = null;
        activeTranscript = [];
        currentSegmentIndex = -1;
        stopSpeaking();

        let existingToast = document.querySelector(".offline-dubber-toast");
        if (existingToast) existingToast.remove();
        if (checkSubtitlesTimeout) clearTimeout(checkSubtitlesTimeout);

        if (videoId && isDubbingActive) {
          isVolumeDucked = false;
          originalVolume = null;

          setTimeout(() => {
            duckVolume();
            triggerSubtitlesIfNeeded();

            checkSubtitlesTimeout = setTimeout(() => {
              if (isDubbingActive && (!activeTranscript || activeTranscript.length === 0)) {
                showToastMessage("Nhắc nhở: Nếu không nghe thuyết minh, vui lòng kiểm tra video có phụ đề Tiếng Việt và nút CC của YouTube đã được bật!");
              }
            }, 4000);
          }, 800);
        }
      }
    } catch (e) { }
  }

  // --- 7. BẬT/TẮT LỒNG TIẾNG VÀ ĐỒNG BỘ NÚT BẤM ---
  function toggleDubbing(btn) {
    isDubbingActive = !isDubbingActive;

    // Cập nhật trạng thái hiển thị trên cả nút desktop và mobile
    const desktopBtn = document.querySelector(".ytp-offline-dub-button");
    const mobileBtn = document.querySelector(".ytp-offline-dub-button-mobile");
    if (desktopBtn) desktopBtn.classList.toggle("ytp-offline-dub-active", isDubbingActive);
    if (mobileBtn) mobileBtn.classList.toggle("ytp-offline-dub-active", isDubbingActive);

    if (isDubbingActive) {

      initVideoTracking();
      duckVolume();
      triggerSubtitlesIfNeeded();
      currentSegmentIndex = -1;

      if (checkSubtitlesTimeout) clearTimeout(checkSubtitlesTimeout);
      checkSubtitlesTimeout = setTimeout(() => {
        if (isDubbingActive && (!activeTranscript || activeTranscript.length === 0)) {
          showToastMessage("Nhắc nhở: Nếu không nghe thuyết minh, vui lòng kiểm tra video có phụ đề Tiếng Việt và nút CC của YouTube đã được bật!");
        }
      }, 4000);
    } else {

      stopSpeaking();
      unduckVolume();

      if (checkSubtitlesTimeout) clearTimeout(checkSubtitlesTimeout);
      let existingToast = document.querySelector(".offline-dubber-toast");
      if (existingToast) existingToast.remove();
    }
  }

  // --- 8. XÂY DỰNG NÚT BẤM DUBBING TRÊN PLAYER (DESKTOP & MOBILE) ---
  function injectDubbingButton() {
    const desktopControlBar = document.querySelector(".ytp-right-controls");

    // Kiểm tra xem nút đã tồn tại chưa ở cả 2 định dạng
    if (document.querySelector(".ytp-offline-dub-button") || document.querySelector(".ytp-offline-dub-button-mobile")) return;

    if (desktopControlBar) {
      // GIAO DIỆN DESKTOP
      const btn = document.createElement("button");
      btn.className = "ytp-button ytp-offline-dub-button";
      btn.title = "Lồng tiếng Offline (Chuột trái bật/tắt, Chuột phải để Cấu hình)";
      btn.setAttribute("aria-label", "Lồng tiếng Offline");

      setInnerHTMLSafe(btn, `
        <svg class="offline-dub-icon" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
          <path d="M12 2c1.66 0 3 1.34 3 3v7c0 1.66-1.34 3-3 3s-3-1.34-3-3V5c0-1.66 1.34-3 3-3zm7 10h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72z" />
        </svg>
      `);

      btn.addEventListener("click", () => toggleDubbing(btn));
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openSettingsModal();
      });

      desktopControlBar.insertBefore(btn, desktopControlBar.firstChild);
    } else {
      // GIAO DIỆN MOBILE - Inject thẳng vào body để tránh bị block bởi player overlay
      const btn = document.createElement("button");
      btn.className = "ytp-offline-dub-button-mobile";
      btn.setAttribute("aria-label", "Lồng tiếng Offline");

      setInnerHTMLSafe(btn, `
        <svg class="offline-dub-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2c1.66 0 3 1.34 3 3v7c0 1.66-1.34 3-3 3s-3-1.34-3-3V5c0-1.66 1.34-3 3-3zm7 10h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72z" />
        </svg>
      `);

      // Mobile Touch events
      btn.addEventListener("click", () => toggleDubbing(btn));

      // Chuột phải hoặc Long-press (nhấn giữ) mở Cài đặt
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openSettingsModal();
      });

      // Nhấp đúp (Double-tap) mở Cài đặt
      let lastTap = 0;
      btn.addEventListener("touchend", (e) => {
        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTap;
        if (tapLength < 300 && tapLength > 0) {
          e.preventDefault();
          openSettingsModal();
        }
        lastTap = currentTime;
      });

      document.body.appendChild(btn);
    }
  }

  // --- 9. CHÈN CSS STYLE (DESKTOP & MOBILE) ---
  function injectCSS() {
    if (document.getElementById("offline-dubber-styles")) return;
    const style = document.createElement("style");
    style.id = "offline-dubber-styles";
    style.textContent = `
      .ytp-offline-dub-button {
        position: relative;
        display: inline-block;
        vertical-align: top;
        width: 46px;
        height: 100%;
        text-align: center;
        cursor: pointer;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        color: #eee;
        transition: color 0.1s cubic-bezier(0.4, 0, 1, 1);
      }
      .ytp-offline-dub-button:hover {
        color: #fff;
      }
      .ytp-offline-dub-button .offline-dub-icon {
        margin: auto;
        width: 20px;
        height: 20px;
        transition: transform 0.15s ease;
      }
      .ytp-offline-dub-button:hover .offline-dub-icon {
        transform: scale(1.1);
      }
      .ytp-offline-dub-button.ytp-offline-dub-active {
        color: #ff0000;
      }
      .ytp-offline-dub-button.ytp-offline-dub-active::after {
        content: '';
        position: absolute;
        bottom: 8px;
        left: 50%;
        transform: translateX(-50%);
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background-color: #ff0000;
        animation: pulse-active-od 1.5s infinite ease-in-out;
      }

      /* Mobile Floating Button Styles (Fixed to viewport) */
      .ytp-offline-dub-button-mobile {
        position: fixed !important;
        bottom: 90px !important;
        right: 16px !important;
        top: auto !important;
        left: auto !important;
        width: 48px !important;
        height: 48px !important;
        border-radius: 50% !important;
        background: rgba(15, 12, 32, 0.95) !important;
        border: 1px solid rgba(255, 255, 255, 0.15) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        color: #eee !important;
        cursor: pointer !important;
        z-index: 99999999 !important;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4) !important;
        transition: transform 0.2s, background-color 0.2s !important;
        padding: 0 !important;
        margin: 0 !important;
      }
      .ytp-offline-dub-button-mobile:active {
        transform: scale(0.9) !important;
      }
      .ytp-offline-dub-button-mobile .offline-dub-icon {
        width: 22px !important;
        height: 22px !important;
      }
      .ytp-offline-dub-button-mobile.ytp-offline-dub-active {
        color: #ff0055 !important;
        border-color: rgba(255, 0, 85, 0.4) !important;
        background: rgba(255, 0, 85, 0.1) !important;
      }
      .ytp-offline-dub-button-mobile.ytp-offline-dub-active::after {
        content: '';
        position: absolute;
        bottom: 2px;
        right: 2px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #ff0055;
        animation: pulse-active-od 1.5s infinite ease-in-out;
      }

      @keyframes pulse-active-od {
        0% { transform: scale(0.8); opacity: 0.5; }
        50% { transform: scale(1.5); opacity: 1; }
        100% { transform: scale(0.8); opacity: 0.5; }
      }

      #offline-dubber-modal-overlay {
        display: none; 
        position: fixed; 
        top: 0; 
        left: 0; 
        width: 100%; 
        height: 100%; 
        background: rgba(0, 0, 0, 0.6); 
        backdrop-filter: blur(5px); 
        z-index: 999999999 !important; 
        justify-content: center; 
        align-items: center;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
      }
      .offline-dubber-modal-content {
        position: relative;
        width: 340px;
        background: linear-gradient(135deg, #0f0c20 0%, #15102a 50%, #06020e 100%);
        color: #f3f0ff;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        padding: 20px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
        box-sizing: border-box;
      }
      .offline-dubber-modal-content .close-btn {
        position: absolute;
        top: 15px;
        right: 15px;
        background: none;
        border: none;
        color: #8b86a3;
        cursor: pointer;
        padding: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;
      }
      .offline-dubber-modal-content .close-btn:hover {
        color: #f3f0ff;
      }
      .offline-dubber-modal-content .header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 15px;
      }
      .offline-dubber-modal-content .logo {
        width: 36px;
        height: 36px;
        background: linear-gradient(135deg, #ff0055, #00d2ff);
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 15px rgba(255, 0, 85, 0.45);
      }
      .offline-dubber-modal-content .logo svg {
        width: 20px;
        height: 20px;
        fill: #fff;
      }
      .offline-dubber-modal-content .title {
        font-size: 18px;
        font-weight: 600;
        background: linear-gradient(90deg, #fff 30%, #8b86a3 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin: 0;
        text-align: left;
      }
      .offline-dubber-modal-content .subtitle {
        font-size: 11px;
        color: #00d2ff;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin-top: 2px;
        font-weight: 600;
        text-align: left;
      }
      .offline-dubber-modal-content .section {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 14px;
        padding: 15px;
        margin-bottom: 15px;
        backdrop-filter: blur(10px);
        transition: border 0.3s ease, box-shadow 0.3s ease;
        text-align: left;
      }
      .offline-dubber-modal-content .section:hover {
        border-color: rgba(0, 210, 255, 0.25);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      }
      .offline-dubber-modal-content .form-group {
        margin-bottom: 15px;
      }
      .offline-dubber-modal-content .form-group:last-child {
        margin-bottom: 0;
      }
      .offline-dubber-modal-content label {
        display: block;
        font-size: 12px;
        color: #8b86a3;
        margin-bottom: 6px;
        font-weight: 400;
        letter-spacing: 0.5px;
      }
      .offline-dubber-modal-content select {
        width: 100%;
        background: rgba(15, 12, 32, 0.85) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        border-radius: 8px !important;
        color: #f3f0ff !important;
        padding: 8px 10px !important;
        font-family: inherit !important;
        font-size: 13px !important;
        outline: none !important;
        cursor: pointer !important;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .offline-dubber-modal-content select:focus {
        border-color: #00d2ff !important;
        box-shadow: 0 0 8px rgba(0, 210, 255, 0.35) !important;
      }
      .offline-dubber-modal-content .slider-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 15px;
      }
      .offline-dubber-modal-content input[type="range"] {
        flex-grow: 1;
        -webkit-appearance: none;
        background: rgba(255, 255, 255, 0.1);
        height: 6px;
        border-radius: 3px;
        outline: none;
      }
      .offline-dubber-modal-content input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #ff0055;
        cursor: pointer;
        box-shadow: 0 0 10px rgba(255, 0, 85, 0.45);
        transition: transform 0.1s;
      }
      .offline-dubber-modal-content input[type="range"]::-webkit-slider-thumb:hover {
        transform: scale(1.2);
      }
      .offline-dubber-modal-content .slider-value {
        font-size: 13px;
        font-weight: 600;
        color: #00d2ff;
        width: 36px;
        text-align: right;
      }
      .offline-dubber-modal-content .btn {
        width: 100%;
        background: linear-gradient(135deg, #ff0055 0%, #d40045 100%);
        border: none;
        border-radius: 10px;
        color: #fff;
        padding: 12px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 15px rgba(255, 0, 85, 0.45);
        transition: transform 0.2s, filter 0.2s, box-shadow 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .offline-dubber-modal-content .btn:hover {
        transform: translateY(-2px);
        filter: brightness(1.1);
        box-shadow: 0 6px 20px rgba(255, 0, 85, 0.6);
      }
      .offline-dubber-modal-content .btn-secondary {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        color: #f3f0ff;
        padding: 10px;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s, transform 0.2s, box-shadow 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        flex: 1;
      }
      .offline-dubber-modal-content .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: #00d2ff;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 210, 255, 0.2);
      }
      .offline-dubber-modal-content .footer {
        text-align: center;
        font-size: 10px;
        color: #8b86a3;
        margin-top: 15px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- 9. KHỞI TẠO VÀ QUẢN LÝ SETTINGS MODAL ---
  function initSettingsModal() {
    if (document.getElementById("offline-dubber-modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "offline-dubber-modal-overlay";

    setInnerHTMLSafe(overlay, `
      <div class="offline-dubber-modal-content">
        <button class="close-btn" id="offline-dubber-close-btn" title="Đóng">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
        <div class="header">
          <div class="logo">
            <svg viewBox="0 0 24 24">
              <path d="M12 2c1.66 0 3 1.34 3 3v7c0 1.66-1.34 3-3 3s-3-1.34-3-3V5c0-1.66 1.34-3 3-3zm7 10h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.41 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72z" />
            </svg>
          </div>
          <div>
            <h1 class="title">YouTube Dubber</h1>
            <div class="subtitle">Offline TTS Player</div>
          </div>
        </div>

        <div class="section">
          <div class="form-group">
            <label for="od-voice-select">Giọng đọc (Speech Voice)</label>
            <select id="od-voice-select">
              <option value="auto">Tự động chọn giọng (Auto)</option>
            </select>
          </div>
        </div>

        <div class="section">
          <div class="form-group">
            <label for="od-duck-range">Âm lượng video gốc (Ducking Level)</label>
            <div class="slider-container">
              <input type="range" id="od-duck-range" min="0" max="100">
              <div class="slider-value" id="od-duck-val">15%</div>
            </div>
          </div>

          <div class="form-group">
            <label for="od-voice-volume-range">Âm lượng lồng tiếng (Voice Volume)</label>
            <div class="slider-container">
              <input type="range" id="od-voice-volume-range" min="0" max="100">
              <div class="slider-value" id="od-voice-volume-val">100%</div>
            </div>
          </div>

          <div class="form-group">
            <label for="od-speed-range">Tốc độ đọc lồng tiếng (Speech Rate)</label>
            <div class="slider-container">
              <input type="range" id="od-speed-range" min="0.5" max="3.0" step="0.05">
              <div class="slider-value" id="od-speed-val">1.35x</div>
            </div>
          </div>
        </div>

        <div class="section" id="od-transcript-section">
          <label>Xuất phụ đề gốc (Transcript)</label>
          <div id="od-no-transcript-msg" style="font-size: 12px; color: #8b86a3; text-align: center; margin: 5px 0 10px; line-height: 1.5;">
            Chưa tải được phụ đề của video này. Vui lòng bật phụ đề (CC) trên video YouTube.
          </div>
          <div id="od-transcript-actions" style="display: none; gap: 10px;">
            <button class="btn-secondary" id="od-download-orig-txt">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
              </svg>
              Bản gốc (.txt)
            </button>
            <button class="btn-secondary" id="od-download-orig-srt">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
              </svg>
              Bản gốc (.srt)
            </button>
          </div>
        </div>

        <button class="btn" id="od-save-btn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" />
          </svg>
          Lưu Cấu Hình
        </button>

        <div class="footer">
          YouTube Offline Dubber (Userscript)
        </div>
      </div>
    `);

    document.body.appendChild(overlay);

    // Gán các phần tử
    const closeBtn = document.getElementById("offline-dubber-close-btn");
    const saveBtn = document.getElementById("od-save-btn");
    const langSelect = document.getElementById("od-lang-select");
    const voiceSelect = document.getElementById("od-voice-select");
    const duckRange = document.getElementById("od-duck-range");
    const duckVal = document.getElementById("od-duck-val");
    const voiceVolumeRange = document.getElementById("od-voice-volume-range");
    const voiceVolumeVal = document.getElementById("od-voice-volume-val");
    const speedRange = document.getElementById("od-speed-range");
    const speedVal = document.getElementById("od-speed-val");
    const downloadOrigTxt = document.getElementById("od-download-orig-txt");
    const downloadOrigSrt = document.getElementById("od-download-orig-srt");

    // Lắng nghe thay đổi slider thời gian thực
    duckRange.addEventListener("input", (e) => {
      duckVal.textContent = e.target.value + "%";
    });
    voiceVolumeRange.addEventListener("input", (e) => {
      voiceVolumeVal.textContent = e.target.value + "%";
    });
    speedRange.addEventListener("input", (e) => {
      speedVal.textContent = parseFloat(e.target.value).toFixed(2) + "x";
    });

    // Sự kiện lưu cấu hình
    saveBtn.addEventListener("click", () => {
      selectedVoiceName = voiceSelect.value;
      duckVolumeLevel = parseInt(duckRange.value);
      voiceVolumeLevel = parseInt(voiceVolumeRange.value);
      ttsSpeedLevel = parseFloat(speedRange.value);

      if (typeof GM_setValue !== "undefined") {
        GM_setValue("voiceName", selectedVoiceName);
        GM_setValue("duckVolume", duckVolumeLevel);
        GM_setValue("voiceVolume", voiceVolumeLevel);
        GM_setValue("ttsSpeed", ttsSpeedLevel);
      }

      // Áp dụng ngay âm lượng nếu đang lồng tiếng
      if (isDubbingActive && videoElement && isVolumeDucked) {
        videoElement.volume = originalVolume * (duckVolumeLevel / 100);
      }

      if (rawSubtitles) {
        activeTranscript = parseSubtitles(rawSubtitles);
        currentSegmentIndex = -1;
        stopSpeaking();
      }

      // Hiệu ứng lưu thành công
      const originalText = saveBtn.innerHTML;
      setInnerHTMLSafe(saveBtn, `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" />
        </svg> Đã Lưu Cấu Hình!
      `);
      saveBtn.style.background = "linear-gradient(135deg, #00d2ff 0%, #00a0c6 100%)";
      saveBtn.style.boxShadow = "0 4px 15px rgba(0, 210, 255, 0.4)";

      setTimeout(() => {
        setInnerHTMLSafe(saveBtn, originalText);
        saveBtn.style.background = "";
        saveBtn.style.boxShadow = "";
        overlay.style.display = "none";
      }, 800);
    });

    // Đóng khi click ra vùng ngoài
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.style.display = "none";
      }
    });

    // Nút đóng
    closeBtn.addEventListener("click", () => {
      overlay.style.display = "none";
    });

    // Xuất dữ liệu
    downloadOrigTxt.addEventListener("click", () => {
      if (activeTranscript.length === 0) return;
      const txtContent = activeTranscript.map(item => item.text).join(" ");
      const filename = `${getYouTubeVideoTitle()}_subtitles.txt`;
      downloadFile(txtContent, filename, "text/plain;charset=utf-8");
    });

    downloadOrigSrt.addEventListener("click", () => {
      if (activeTranscript.length === 0) return;
      const srtContent = activeTranscript.map((item, index) => {
        const start = formatMsToSrtTime(item.start);
        const end = formatMsToSrtTime(item.start + item.duration);
        return `${index + 1}\n${start} --> ${end}\n${item.text}\n`;
      }).join("\n");
      const filename = `${getYouTubeVideoTitle()}_subtitles.srt`;
      downloadFile(srtContent, filename, "text/srt;charset=utf-8");
    });
  }

  function openSettingsModal() {
    initSettingsModal();

    const overlay = document.getElementById("offline-dubber-modal-overlay");
    overlay.style.display = "flex";

    // Đồng bộ lại các giá trị lên form
    const duckRange = document.getElementById("od-duck-range");
    const voiceVolumeRange = document.getElementById("od-voice-volume-range");
    const speedRange = document.getElementById("od-speed-range");

    duckRange.value = duckVolumeLevel;
    document.getElementById("od-duck-val").textContent = `${duckVolumeLevel}%`;
    voiceVolumeRange.value = voiceVolumeLevel;
    document.getElementById("od-voice-volume-val").textContent = `${voiceVolumeLevel}%`;
    speedRange.value = ttsSpeedLevel;
    document.getElementById("od-speed-val").textContent = `${parseFloat(ttsSpeedLevel).toFixed(2)}x`;

    // Nạp lại danh sách giọng đọc
    const voiceSelect = document.getElementById("od-voice-select");
    const voices = window.speechSynthesis.getVoices();
    const currentValue = selectedVoiceName;

    setInnerHTMLSafe(voiceSelect, '<option value="auto">Tự động chọn giọng (Auto)</option>');
    voices.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      voiceSelect.appendChild(option);
    });
    voiceSelect.value = currentValue;

    // Hiển thị nút tải phụ đề nếu có sẵn phụ đề
    const noTranscriptMsg = document.getElementById("od-no-transcript-msg");
    const transcriptActions = document.getElementById("od-transcript-actions");

    if (activeTranscript && activeTranscript.length > 0) {
      noTranscriptMsg.style.display = "none";
      transcriptActions.style.display = "flex";
    } else {
      noTranscriptMsg.style.display = "block";
      transcriptActions.style.display = "none";
    }
  }

  // --- 10. HELPERS DOWLOAD & FORMAT ---
  function getYouTubeVideoTitle() {
    const titleEl = document.querySelector('h1.style-scope.ytd-watch-metadata') ||
      document.querySelector('h1.ytd-video-primary-info-renderer') ||
      document.querySelector('title');
    const titleText = titleEl ? (titleEl.textContent || titleEl.innerText) : "youtube_transcript";
    return titleText.trim().replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  function formatMsToSrtTime(ms) {
    const date = new Date(ms);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    const mmm = String(date.getUTCMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss},${mmm}`;
  }

  // Đăng ký lệnh menu Tampermonkey
  if (typeof GM_registerMenuCommand !== "undefined") {
    GM_registerMenuCommand("⚙️ Cài đặt YouTube Offline Dubber", openSettingsModal);
  }

  function isWatchPage() {
    return window.location.pathname.includes("/watch") || window.location.pathname.includes("/shorts");
  }

  // --- 11. KHỞI CHẠY KIỂM TRA DOM ĐỊNH KỲ ---
  setInterval(() => {
    checkVideoIdChange();
    injectCSS();
    injectDubbingButton();
    initVideoTracking();

    // Đồng bộ hiển thị nút nổi di động theo trạng thái trang phát video
    const mobileBtn = document.querySelector(".ytp-offline-dub-button-mobile");
    if (mobileBtn) {
      if (isWatchPage()) {
        mobileBtn.style.setProperty("display", "flex", "important");
      } else {
        mobileBtn.style.setProperty("display", "none", "important");
        if (isDubbingActive) {
          toggleDubbing(mobileBtn); // Tự động tắt nếu rời trang xem
        }
      }
    }
  }, 1000);

  // Kích hoạt nạp sẵn giọng đọc
  window.speechSynthesis.getVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };
  }

})();
