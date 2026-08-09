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
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
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
  let toastTimeout = null;
  let currentVideoId = null;

  // Biến trạng thái Dịch Phụ Đề Video Thời Gian Thực
  let isSubTranslateActive = false;
  let subTranslationCache = new Map(); // Index -> Translated Vietnamese text
  let isTranslatingSubtitles = false;
  let rawTranscriptOriginal = [];

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

  // 1. Hàm làm sạch phụ đề (lọc bỏ các thẻ rác [...], (...), xóa sạch \\n, chuẩn hóa khoảng trắng quanh dấu chấm phẩy và loại bỏ từ lặp)
  function cleanSubtitleText(text) {
    if (!text) return "";
    let cleaned = text
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\([^\)]*\)/g, "")
      .replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ")
      .replace(/\\[rn]/g, " ")
      .replace(/\s*([.!?…,;:–—])\s*/g, "$1 ")
      .replace(/\s+/g, " ")
      .trim();

    // Lọc bỏ từ bị lặp lại liên tiếp do phụ đề ASR cuộn tự động của YouTube (ví dụ: "welcome welcome" -> "welcome")
    cleaned = cleaned.replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1");
    return cleaned;
  }

  // Hàm ghép 2 chuỗi không bị lặp lại các từ trùng ở ranh giới giữa 2 câu
  function appendWithoutDuplicateWords(str1, str2) {
    if (!str1) return str2 || "";
    if (!str2) return str1 || "";
    const s1 = str1.trim();
    const s2 = str2.trim();

    if (s1.endsWith(s2)) return s1;
    if (s2.startsWith(s1)) return s2;

    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);

    const maxOverlap = Math.min(words1.length, words2.length);
    let overlapCount = 0;

    for (let len = maxOverlap; len >= 1; len--) {
      const tail1 = words1.slice(-len).join(" ").toLowerCase();
      const head2 = words2.slice(0, len).join(" ").toLowerCase();
      if (tail1 === head2) {
        overlapCount = len;
        break;
      }
    }

    if (overlapCount > 0) {
      return words1.concat(words2.slice(overlapCount)).join(" ");
    }

    return s1 + " " + s2;
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
          current.text = appendWithoutDuplicateWords(current.text, item.text);
          current.duration = proposedEnd - current.start;
        }
      }
    }

    if (current) merged.push(current);

    return merged;
  }

  // Lọc bỏ triệt để các vế/câu trùng lặp trong dữ liệu phụ đề ASR tự động của YouTube
  function deduplicateTranscriptEvents(rawTranscript) {
    if (!Array.isArray(rawTranscript) || rawTranscript.length === 0) return [];

    const result = [];
    const recentSentences = []; // Hàng đợi lưu 25 vế câu gần nhất

    for (const item of rawTranscript) {
      if (!item.text) continue;

      // Tách item.text thành các vế câu dựa trên dấu câu hoặc 2 khoảng trắng trở lên
      const sentences = item.text.split(/(?<=[.!?…,;:–—])\s+|\s{2,}/);

      const uniqueParts = [];
      for (let s of sentences) {
        s = cleanSubtitleText(s);
        if (!s || s.length < 2) continue;

        // Chuẩn hóa chữ thường và xóa ký tự đặc biệt để so sánh chuẩn xác
        const norm = s.toLowerCase().replace(/[^a-z0-9\u00C0-\u1EF9]/g, "");
        if (!norm) continue;

        // Nếu vế câu này đã từng xuất hiện trong 25 vế câu gần nhất -> BỎ QUA HOÀN TOÀN
        if (recentSentences.includes(norm)) {
          continue;
        }

        recentSentences.push(norm);
        if (recentSentences.length > 25) recentSentences.shift();

        uniqueParts.push(s);
      }

      if (uniqueParts.length > 0) {
        const cleanText = uniqueParts.join(" ");
        result.push({
          start: item.start,
          duration: item.duration,
          text: cleanText
        });
      }
    }

    return result;
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

    const deduplicated = deduplicateTranscriptEvents(transcript);
    return mergeSubtitles(deduplicated);
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

      // Kích hoạt dịch trước (Lookahead) các đoạn phụ đề tiếp theo trong nền khi đang phát
      if (isSubTranslateActive) {
        translateSubtitlesRealtime(activeIndex);
      }
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
        // Khi tua video (Seeking): Lập tức ưu tiên dịch đoạn phụ đề tại vị trí thời gian mới
        if (isSubTranslateActive && videoElement) {
          const currentTimeMs = videoElement.currentTime * 1000;
          const newIdx = findActiveSegmentIndex(currentTimeMs);
          translateSubtitlesRealtime(newIdx);
        }
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
    rawTranscriptOriginal = parseSubtitles(rawSubtitles);
    activeTranscript = JSON.parse(JSON.stringify(rawTranscriptOriginal));
    subTranslationCache.clear();
    applyCacheToActiveTranscript();
    currentSegmentIndex = -1;
    stopSpeaking();

    if (isSubTranslateActive) {
      translateSubtitlesRealtime();
    }
  });

  // Kiểm tra đổi video (Single Page Application của YouTube)
  function checkVideoIdChange() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const videoId = urlParams.get("v");
      if (videoId !== currentVideoId) {
        currentVideoId = videoId;

        rawSubtitles = null;
        rawTranscriptOriginal = [];
        activeTranscript = [];
        subTranslationCache.clear();
        currentSegmentIndex = -1;
        stopSpeaking();

        let existingToast = document.querySelector(".offline-dubber-toast");
        if (existingToast) existingToast.remove();

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

  // --- 8.6 NÚT BẤM DỊCH PHỤ ĐỀ VIDEO THỜI GIAN THỰC (REALTIME SUBTITLE TRANSLATION) ---
  function injectTranslateSubtitlesButton() {
    if (document.querySelector(".ytp-offline-translate-subtitles-button-mobile") || document.querySelector(".ytp-offline-translate-subtitles-button")) return;

    const desktopControlBar = document.querySelector(".ytp-right-controls");

    if (desktopControlBar) {
      const btn = document.createElement("button");
      btn.className = "ytp-button ytp-offline-translate-subtitles-button";
      btn.title = "Dịch phụ đề video sang Tiếng Việt (Bật/Tắt Realtime)";
      btn.setAttribute("aria-label", "Dịch phụ đề video");

      setInnerHTMLSafe(btn, `
        <svg class="offline-dub-icon" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
          <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
        </svg>
      `);

      btn.addEventListener("click", () => toggleSubTranslation(btn));
      desktopControlBar.insertBefore(btn, desktopControlBar.firstChild);
    }

    const mobileBtn = document.createElement("button");
    mobileBtn.className = "ytp-offline-translate-subtitles-button-mobile";
    mobileBtn.setAttribute("aria-label", "Dịch phụ đề video");
    mobileBtn.title = "Dịch phụ đề video sang Tiếng Việt";

    setInnerHTMLSafe(mobileBtn, `
      <svg class="offline-dub-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
      </svg>
    `);

    mobileBtn.addEventListener("click", () => toggleSubTranslation(mobileBtn));
    document.body.appendChild(mobileBtn);
  }

  // --- 8.5 NÚT BẤM DỊCH BÌNH LUẬN THỦ CÔNG (ON-DEMAND BUTTON) ---
  function injectTranslateCommentsButton() {
    if (document.querySelector(".ytp-offline-translate-button-mobile") || document.querySelector(".ytp-offline-translate-button")) return;

    const desktopControlBar = document.querySelector(".ytp-right-controls");

    if (desktopControlBar) {
      const btn = document.createElement("button");
      btn.className = "ytp-button ytp-offline-translate-button";
      btn.title = "Dịch các bình luận hiện tại sang Tiếng Việt";
      btn.setAttribute("aria-label", "Dịch bình luận");

      setInnerHTMLSafe(btn, `
        <svg class="offline-dub-icon" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
          <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
        </svg>
      `);

      btn.addEventListener("click", () => translateCurrentVisibleComments(btn));
      desktopControlBar.insertBefore(btn, desktopControlBar.firstChild);
    }

    const mobileBtn = document.createElement("button");
    mobileBtn.className = "ytp-offline-translate-button-mobile";
    mobileBtn.setAttribute("aria-label", "Dịch bình luận");
    mobileBtn.title = "Dịch các bình luận hiện tại sang Tiếng Việt";

    setInnerHTMLSafe(mobileBtn, `
      <svg class="offline-dub-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
    `);

    mobileBtn.addEventListener("click", () => translateCurrentVisibleComments(mobileBtn));
    document.body.appendChild(mobileBtn);
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

      /* Desktop Translate Comments Button */
      .ytp-offline-translate-button {
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
        color: #00d2ff;
        transition: color 0.1s cubic-bezier(0.4, 0, 1, 1);
      }
      .ytp-offline-translate-button:hover {
        color: #fff;
      }
      .ytp-offline-translate-button .offline-dub-icon {
        margin: auto;
        width: 20px;
        height: 20px;
        transition: transform 0.15s ease;
      }
      .ytp-offline-translate-button:hover .offline-dub-icon {
        transform: scale(1.1);
      }

      /* Floating Translate Comments Button (Fixed to viewport) */
      .ytp-offline-translate-button-mobile {
        position: fixed !important;
        bottom: 148px !important;
        right: 16px !important;
        top: auto !important;
        left: auto !important;
        width: 48px !important;
        height: 48px !important;
        border-radius: 50% !important;
        background: rgba(15, 12, 32, 0.95) !important;
        border: 1px solid rgba(0, 210, 255, 0.4) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        color: #00d2ff !important;
        cursor: pointer !important;
        z-index: 99999999 !important;
        box-shadow: 0 4px 15px rgba(0, 210, 255, 0.25) !important;
        transition: transform 0.2s, background-color 0.2s !important;
        padding: 0 !important;
        margin: 0 !important;
      }
      .ytp-offline-translate-button-mobile:active {
        transform: scale(0.9) !important;
      }
      .ytp-offline-translate-button-mobile .offline-dub-icon {
        width: 22px !important;
        height: 22px !important;
      }
      .ytp-offline-translate-button-mobile.ytp-offline-translating {
        color: #ff0055 !important;
        border-color: rgba(255, 0, 85, 0.6) !important;
        background: rgba(255, 0, 85, 0.15) !important;
        animation: pulse-active-od 1s infinite ease-in-out;
      }

      /* Desktop Subtitle Translate Button */
      .ytp-offline-translate-subtitles-button {
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
        color: #ff0055;
        transition: color 0.1s cubic-bezier(0.4, 0, 1, 1);
      }
      .ytp-offline-translate-subtitles-button:hover {
        color: #fff;
      }
      .ytp-offline-translate-subtitles-button .offline-dub-icon {
        margin: auto;
        width: 20px;
        height: 20px;
        transition: transform 0.15s ease;
      }

      /* Floating Subtitle Translate Button (Positioned at 206px above comment translate button) */
      .ytp-offline-translate-subtitles-button-mobile {
        position: fixed !important;
        bottom: 206px !important;
        right: 16px !important;
        top: auto !important;
        left: auto !important;
        width: 48px !important;
        height: 48px !important;
        border-radius: 50% !important;
        background: rgba(15, 12, 32, 0.95) !important;
        border: 1px solid rgba(255, 0, 85, 0.5) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        color: #ff0055 !important;
        cursor: pointer !important;
        z-index: 99999999 !important;
        box-shadow: 0 4px 15px rgba(255, 0, 85, 0.3) !important;
        transition: transform 0.2s, background-color 0.2s !important;
        padding: 0 !important;
        margin: 0 !important;
      }
      .ytp-offline-translate-subtitles-button-mobile:active {
        transform: scale(0.9) !important;
      }
      .ytp-offline-translate-subtitles-button-mobile .offline-dub-icon {
        width: 22px !important;
        height: 22px !important;
      }
      .ytp-offline-translate-subtitles-button-mobile.ytp-offline-sub-translating {
        color: #00d2ff !important;
        border-color: rgba(0, 210, 255, 0.8) !important;
        background: rgba(0, 210, 255, 0.2) !important;
        box-shadow: 0 4px 15px rgba(0, 210, 255, 0.4) !important;
      }

      /* Khung dịch bình luận tương thích hoàn hảo cả Giao diện Sáng & Tối */
      .yt-offline-comment-translation {
        margin-top: 8px !important;
        margin-bottom: 8px !important;
        padding: 8px 12px !important;
        background: var(--yt-spec-badge-chip-background, rgba(0, 210, 255, 0.06)) !important;
        border-left: 3px solid #ff0055 !important;
        border-radius: 8px !important;
        font-size: 13.5px !important;
        line-height: 1.45 !important;
        color: var(--yt-spec-text-primary, inherit) !important;
        word-break: break-word !important;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05) !important;
        transition: background-color 0.2s ease, color 0.2s ease;
      }
      .yt-offline-comment-translation .trans-label {
        display: inline-block;
        font-weight: 700;
        color: #ff0055 !important;
        margin-right: 6px;
        font-size: 12px;
        letter-spacing: 0.3px;
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
    const autoTranslateCheckbox = document.getElementById("od-auto-translate-comments");
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
      autoTranslateComments = autoTranslateCheckbox.checked;

      if (typeof GM_setValue !== "undefined") {
        GM_setValue("voiceName", selectedVoiceName);
        GM_setValue("duckVolume", duckVolumeLevel);
        GM_setValue("voiceVolume", voiceVolumeLevel);
        GM_setValue("ttsSpeed", ttsSpeedLevel);
        GM_setValue("autoTranslateComments", autoTranslateComments);
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
    const autoTranslateCheckbox = document.getElementById("od-auto-translate-comments");
    if (autoTranslateCheckbox) {
      autoTranslateCheckbox.checked = autoTranslateComments;
    }

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

  // --- 11. TỰ ĐỘNG DỊCH BÌNH LUẬN YOUTUBE THEO NHU CẦU (ON-DEMAND) ---
  let isTranslatingBatch = false;

  async function translateTextToVietnamese(text) {
    if (!text || !text.trim()) return null;
    const cleanText = text.trim();
    if (cleanText.length < 2) return null;

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(cleanText)}`;

    try {
      if (typeof GM_xmlhttpRequest !== "undefined") {
        return new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "GET",
            url: url,
            onload: function (res) {
              try {
                const data = JSON.parse(res.responseText);
                if (data && data[2] === "vi") return resolve(null); // Đã là Tiếng Việt
                if (data && data[0] && Array.isArray(data[0])) {
                  const translatedText = data[0].map(item => item[0]).filter(Boolean).join("");
                  return resolve(translatedText);
                }
              } catch (e) { }
              resolve(null);
            },
            onerror: function () { resolve(null); }
          });
        });
      } else {
        const res = await fetch(url);
        const data = await res.json();
        if (data && data[2] === "vi") return null; // Đã là Tiếng Việt
        if (data && data[0] && Array.isArray(data[0])) {
          return data[0].map(item => item[0]).filter(Boolean).join("");
        }
      }
    } catch (e) { }
    return null;
  }

  async function translateCurrentVisibleComments(btn = null) {
    if (isTranslatingBatch) return;

    const selectors = [
      'p.YtmCommentRendererText',
      '.YtmCommentRendererText',
      'ytd-comment-thread-renderer #content-text',
      'ytd-comment-view-model #content-text',
      '#content-text'
    ];

    const commentElements = document.querySelectorAll(selectors.join(', '));
    if (!commentElements.length) {
      showToastMessage("Không tìm thấy bình luận nào trên màn hình.");
      return;
    }

    const untranslated = [];
    commentElements.forEach(el => {
      if (!el.dataset.translated && !el.dataset.translating) {
        const parent = el.closest('ytm-comment-renderer, ytd-comment-renderer, ytd-comment-view-model, .YtmCommentThreadRendererHost') || el.parentNode;
        if (parent && !parent.querySelector('.yt-offline-comment-translation')) {
          untranslated.push(el);
        }
      }
    });

    if (untranslated.length === 0) {
      showToastMessage("Tất cả bình luận hiện tại đã được dịch!");
      return;
    }

    isTranslatingBatch = true;
    if (btn) btn.classList.add("ytp-offline-translating");
    showToastMessage(`Đang dịch ${untranslated.length} bình luận...`);

    let translatedCount = 0;
    for (let i = 0; i < untranslated.length; i += 5) {
      const chunk = untranslated.slice(i, i + 5);
      await Promise.all(chunk.map(async (el) => {
        el.dataset.translating = "true";
        try {
          let originalText = el.innerText || el.textContent || "";
          originalText = originalText.trim();

          if (originalText.length >= 2) {
            const translated = await translateTextToVietnamese(originalText);
            if (translated && translated.trim() !== originalText) {
              const transBox = document.createElement("div");
              transBox.className = "yt-offline-comment-translation";
              setInnerHTMLSafe(transBox, `<span class="trans-label">🇻🇳 Dịch:</span>${translated}`);

              if (el.nextSibling) {
                el.parentNode.insertBefore(transBox, el.nextSibling);
              } else {
                el.parentNode.appendChild(transBox);
              }
              translatedCount++;
            }
          }
        } catch (e) { }
        el.dataset.translated = "true";
        delete el.dataset.translating;
      }));
    }

    isTranslatingBatch = false;
    if (btn) btn.classList.remove("ytp-offline-translating");

    if (translatedCount > 0) {
      showToastMessage(`Hoàn tất dịch ${translatedCount} bình luận!`);
    } else {
      showToastMessage("Các bình luận hiện tại đã là Tiếng Việt.");
    }
  }

  // --- 11.4 HÀNG ĐỘI DỊCH PHỤ ĐỀ VIDEO THỜI GIAN THỰC (SMART REALTIME SUBTITLE PIPELINE) ---
  function applyCacheToActiveTranscript() {
    if (!activeTranscript || !activeTranscript.length) return;
    if (isSubTranslateActive) {
      activeTranscript.forEach((seg, idx) => {
        if (subTranslationCache.has(idx)) {
          seg.text = subTranslationCache.get(idx);
        } else if (rawTranscriptOriginal[idx]) {
          seg.text = rawTranscriptOriginal[idx].text;
        }
      });
    } else {
      activeTranscript.forEach((seg, idx) => {
        if (rawTranscriptOriginal[idx]) {
          seg.text = rawTranscriptOriginal[idx].text;
        }
      });
    }
  }

  async function translateSubtitlesRealtime(priorityIndex = -1) {
    if (!isSubTranslateActive || !rawTranscriptOriginal.length || isTranslatingSubtitles) return;

    let targetIndex = priorityIndex;
    if (targetIndex === -1 && videoElement) {
      const currentTimeMs = videoElement.currentTime * 1000;
      targetIndex = findActiveSegmentIndex(currentTimeMs);
      if (targetIndex === -1) targetIndex = 0;
    }

    const toTranslate = [];
    const total = rawTranscriptOriginal.length;

    // Ưu tiên dịch từ targetIndex đến targetIndex + 5 (Lookahead Buffer 6 đoạn)
    for (let i = 0; i < 6; i++) {
      const idx = (targetIndex + i) % total;
      if (!subTranslationCache.has(idx) && rawTranscriptOriginal[idx]) {
        toTranslate.push(idx);
      }
    }

    if (toTranslate.length === 0) return;

    isTranslatingSubtitles = true;

    await Promise.all(toTranslate.map(async (idx) => {
      const origItem = rawTranscriptOriginal[idx];
      if (!origItem || !origItem.text) return;

      const translated = await translateTextToVietnamese(origItem.text);
      if (translated && translated.trim() !== origItem.text) {
        subTranslationCache.set(idx, translated);
        if (activeTranscript[idx]) {
          activeTranscript[idx].text = translated;
        }
        console.log(`%c[YT Dubber - Dịch %c#${idx}]`, "color: #00d2ff; font-weight: bold;", "color: #ff0055;",
          `\n🔴 Gốc (${origItem.start}ms): "${origItem.text}"\n🇻🇳 Dịch: "${translated}"`);
      }
    }));

    isTranslatingSubtitles = false;
  }

  function toggleSubTranslation(btn = null) {
    isSubTranslateActive = !isSubTranslateActive;

    const desktopBtn = document.querySelector(".ytp-offline-translate-subtitles-button");
    const mobileBtn = document.querySelector(".ytp-offline-translate-subtitles-button-mobile");

    if (desktopBtn) desktopBtn.classList.toggle("ytp-offline-sub-translating", isSubTranslateActive);
    if (mobileBtn) mobileBtn.classList.toggle("ytp-offline-sub-translating", isSubTranslateActive);

    if (isSubTranslateActive) {
      // 1. Tự động bật Lồng tiếng nếu chưa bật
      if (!isDubbingActive) {
        toggleDubbing();
      }
      // 2. Tự động bật nút CC của YouTube nếu chưa bật
      triggerSubtitlesIfNeeded();
    }

    applyCacheToActiveTranscript();

    if (isSubTranslateActive) {
      showToastMessage("🌐 Đã BẬT Dịch Phụ Đề Video Thời Gian Thực sang Tiếng Việt!");
      translateSubtitlesRealtime();
    } else {
      showToastMessage("Đã TẮT Dịch Phụ Đề Video, quay lại phụ đề gốc.");
    }
  }

  // --- 11.5 TỰ ĐỘNG ĐẨY TIẾNG VIỆT LÊN ĐẦU DÒNG (PIN VIETNAMESE TO TOP) ---
  function promoteVietnameseToTop() {
    const titleSpans = document.querySelectorAll('.ytListItemViewModelTitle, .ytp-menuitem-label, span[role="text"]');
    let viItem = null;

    for (const span of titleSpans) {
      const text = (span.textContent || "").trim();
      if (text === "Tiếng Việt") {
        viItem = span.closest('yt-list-item-view-model, .ytListItemViewModelHost, .ytp-menuitem');
        if (viItem) break;
      }
    }

    if (!viItem) return;

    const listParent = viItem.parentElement;
    if (!listParent) return;

    // Nếu phần tử Tiếng Việt chưa ở vị trí ĐẦU TIÊN (trên cả Kri)
    if (listParent.firstElementChild !== viItem) {
      // Đưa phần tử Tiếng Việt lên vị trí số 1 ngay đầu danh sách
      listParent.insertBefore(viItem, listParent.firstElementChild);

      // Thêm hiệu ứng viền sáng cyan và nền nổi bật
      viItem.style.setProperty("border-left", "4px solid #00d2ff", "important");
      viItem.style.setProperty("background", "rgba(0, 210, 255, 0.12)", "important");
      viItem.style.setProperty("border-radius", "8px", "important");
      viItem.style.setProperty("margin-bottom", "6px", "important");
    }
  }

  // --- 12. KHỞI CHẠY KIỂM TRA DOM ĐỊNH KỲ ---
  setInterval(() => {
    checkVideoIdChange();
    injectCSS();
    injectDubbingButton();
    injectTranslateCommentsButton();
    injectTranslateSubtitlesButton();
    promoteVietnameseToTop();
    initVideoTracking();

    // Nếu đang bật dịch phụ đề video, duy trì luồng dịch trước trong nền
    if (isSubTranslateActive && rawTranscriptOriginal.length > 0) {
      translateSubtitlesRealtime();
    }

    // Đồng bộ hiển thị nút nổi di động theo trạng thái trang phát video
    const mobileDubBtn = document.querySelector(".ytp-offline-dub-button-mobile");
    const mobileTransBtn = document.querySelector(".ytp-offline-translate-button-mobile");
    const mobileSubTransBtn = document.querySelector(".ytp-offline-translate-subtitles-button-mobile");

    const onWatch = isWatchPage();
    if (mobileDubBtn) {
      mobileDubBtn.style.setProperty("display", onWatch ? "flex" : "none", "important");
      if (!onWatch && isDubbingActive) toggleDubbing(mobileDubBtn);
    }
    if (mobileTransBtn) {
      mobileTransBtn.style.setProperty("display", onWatch ? "flex" : "none", "important");
    }
    if (mobileSubTransBtn) {
      mobileSubTransBtn.style.setProperty("display", onWatch ? "flex" : "none", "important");
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
