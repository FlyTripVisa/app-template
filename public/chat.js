
/**
 * FlyTripVisa AI Worker Chat
 * Endpoint: POST /api/chat
 * Request:  { messages: [{ role, content }] }
 * Response: Server-Sent Events (SSE)
 */

"use strict";

const messagesList = document.getElementById("messagesList");
const welcomeScreen = document.getElementById("welcomeScreen");
const messageArea = document.getElementById("messageArea");
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const typingIndicator = document.getElementById("typingIndicator");
const copyBtn = document.getElementById("copyBtn");

const API_URL = "/api/chat";
const REQUEST_TIMEOUT_MS = 120000;
const MAX_HISTORY_MESSAGES = 40;

let chatHistory = [];
let isProcessing = false;
let activeController = null;

function scrollToBottom() {
  requestAnimationFrame(() => {
    messageArea.scrollTop = messageArea.scrollHeight;
  });
}

function updateSendButton() {
  sendButton.disabled = isProcessing || !userInput.value.trim();
}

function updateWelcomeScreen() {
  welcomeScreen.style.display =
    chatHistory.length === 0 ? "flex" : "none";
}

function addMessageToChat(role, content, isError = false) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}`;

  if (isError) {
    messageEl.classList.add("error");
  }

  // Never interpret AI output as HTML.
  messageEl.textContent = content;
  messagesList.appendChild(messageEl);
  scrollToBottom();

  return messageEl;
}

function setTyping(visible) {
  typingIndicator.classList.toggle("visible", visible);
  if (visible) scrollToBottom();
}

/**
 * Extract generated text from common streaming formats.
 * Supports Workers AI response chunks and OpenAI-style deltas.
 */
function extractContent(data) {
  if (typeof data === "string") return data;

  if (!data || typeof data !== "object") return "";

  if (typeof data.response === "string") return data.response;
  if (typeof data.text === "string") return data.text;
  if (typeof data.token === "string") return data.token;

  if (typeof data.result?.response === "string") {
    return data.result.response;
  }

  if (typeof data.result?.text === "string") {
    return data.result.text;
  }

  const delta = data.choices?.[0]?.delta?.content;

  if (typeof delta === "string") return delta;

  const choiceText = data.choices?.[0]?.text;

  if (typeof choiceText === "string") return choiceText;

  return "";
}

/**
 * Parse SSE frames separated by blank lines.
 * Handles CRLF and multiple data: lines.
 */
function consumeSseEvents(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events = [];
  let remaining = normalized;

  while (true) {
    const match = /\n\n/.exec(remaining);
    if (!match) break;

    const rawEvent = remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);

    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));

    if (dataLines.length) {
      events.push(dataLines.join("\n"));
    }
  }

  return { events, buffer: remaining };
}

function parseSsePayload(data) {
  if (data === "[DONE]") return { done: true, content: "" };

  try {
    const parsed = JSON.parse(data);

    if (parsed.error) {
      throw new Error(
        typeof parsed.error === "string"
          ? parsed.error
          : "The AI service returned an error."
      );
    }

    return {
      done: false,
      content: extractContent(parsed)
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Some SSE services stream plain text rather than JSON.
      return { done: false, content: data };
    }

    throw error;
  }
}

async function sendMessage() {
  const message = userInput.value.trim();

  if (!message || isProcessing) return;

  isProcessing = true;
  updateSendButton();
  userInput.disabled = true;

  addMessageToChat("user", message);
  chatHistory.push({ role: "user", content: message });

  userInput.value = "";
  userInput.style.height = "auto";

  updateWelcomeScreen();
  setTyping(true);

  const assistantBubble = addMessageToChat("bot", "");
  let responseText = "";
  let timeoutId;

  activeController = new AbortController();

  timeoutId = setTimeout(() => {
    activeController?.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({
        messages: chatHistory.slice(-MAX_HISTORY_MESSAGES)
      }),
      signal: activeController.signal,
      cache: "no-store",
      credentials: "same-origin"
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Chat API returned HTTP ${response.status}` +
        (detail ? `: ${detail}` : "")
      );
    }

    if (!response.body) {
      throw new Error("The server did not provide a response stream.");
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/event-stream")) {
      throw new Error(
        "Expected an SSE response. Check the Worker /api/chat endpoint."
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let finished = false;

    function processEvent(data) {
      const result = parseSsePayload(data);

      if (result.done) {
        finished = true;
        return;
      }

      if (result.content) {
        responseText += result.content;
        assistantBubble.textContent = responseText;
        scrollToBottom();
      }
    }

    try {
      while (!finished) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parsed = consumeSseEvents(buffer);
        buffer = parsed.buffer;

        for (const data of parsed.events) {
          processEvent(data);
          if (finished) break;
        }
      }

      // Flush any bytes buffered by TextDecoder.
      buffer += decoder.decode();

      if (!finished && buffer.trim()) {
        const parsed = consumeSseEvents(buffer + "\n\n");

        for (const data of parsed.events) {
          processEvent(data);
          if (finished) break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!responseText.trim()) {
      throw new Error("The model returned no text. Check the Worker logs.");
    }

    chatHistory.push({
      role: "assistant",
      content: responseText
    });
  } catch (error) {
    console.error("Chat request failed:", error);

    assistantBubble.remove();

    let errorMessage = error.message || "An unexpected error occurred.";

    if (error.name === "AbortError") {
      errorMessage = "The request timed out or was cancelled. Please try again.";
    } else if (error instanceof TypeError) {
      errorMessage = "Network error. Check your connection and Worker deployment.";
    }

    addMessageToChat("bot", `⚠️ ${errorMessage}`, true);

    // Remove the failed user turn so the next request can retry cleanly.
    chatHistory.pop();
  } finally {
    clearTimeout(timeoutId);
    activeController = null;
    isProcessing = false;
    userInput.disabled = false;

    setTyping(false);
    updateSendButton();

    if (!window.matchMedia("(max-width: 767px)").matches) {
      userInput.focus();
    }
  }
}

// Auto-resize the input for mobile and desktop.
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 220) + "px";
  updateSendButton();
});

// Enter sends; Shift+Enter adds a newline.
userInput.addEventListener("keydown", function (event) {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();

    if (!sendButton.disabled) {
      chatForm.requestSubmit();
    }
  }

  if (event.key === "Escape" && activeController) {
    activeController.abort();
  }
});

chatForm.addEventListener("submit", function (event) {
  event.preventDefault();
  sendMessage();
});

// Copy the displayed example code.
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const code = document.querySelector(".code-block code");
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code.textContent);
      copyBtn.textContent = "Copied!";

      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1500);
    } catch (error) {
      console.error("Clipboard error:", error);
      copyBtn.textContent = "Copy unavailable";
    }
  });
}

updateWelcomeScreen();
updateSendButton();
