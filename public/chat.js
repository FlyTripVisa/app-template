/**
 * LLM Chat App Frontend
 * Works with the LlamaIndex-style index.html
 * Handles streaming SSE responses from /api/chat
 */

// ---------- DOM elements ----------
const messagesList    = document.getElementById("messagesList");
const welcomeScreen   = document.getElementById("welcomeScreen");
const messageArea     = document.getElementById("messageArea");
const chatForm        = document.getElementById("chatForm");
const userInput       = document.getElementById("messageInput");
const sendButton      = document.getElementById("sendButton");
const typingIndicator = document.getElementById("typingIndicator");

// ---------- Chat state ----------
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];
let isProcessing = false;

// ---------- Auto-resize textarea ----------
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = Math.min(this.scrollHeight, 400) + "px";
	updateSendButton();
});

// ---------- Enter to send, Shift+Enter for newline ----------
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// ---------- Form submit (send button click) ----------
chatForm.addEventListener("submit", function (e) {
	e.preventDefault();
	sendMessage();
});

// ---------- Enable/disable send button ----------
function updateSendButton() {
	const hasText = userInput.value.trim().length > 0;
	sendButton.disabled = !hasText || isProcessing;
}

// ---------- Show / hide welcome screen ----------
function updateWelcomeScreen() {
	// Hide welcome as soon as the user has interacted (chatHistory > 1)
	if (chatHistory.length > 1) {
		welcomeScreen.style.display = "none";
	} else {
		welcomeScreen.style.display = "flex";
	}
}

// ---------- Scroll to bottom ----------
function scrollToBottom() {
	messageArea.scrollTop = messageArea.scrollHeight;
}

// ---------- Add a message bubble ----------
function addMessageToChat(role, content) {
	// `role` should be "user" or "bot" to match your CSS
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}`;
	messageEl.textContent = content; // textContent is safer than innerHTML
	messagesList.appendChild(messageEl);
	scrollToBottom();
	return messageEl;
}

// ---------- SSE parser ----------
function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}

// ---------- Extract text from a streamed JSON chunk ----------
function extractContent(jsonData) {
	// Workers AI: { response: "..." }
	if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
		return jsonData.response;
	}
	// OpenAI-style: { choices: [{ delta: { content: "..." } }] }
	if (jsonData.choices?.[0]?.delta?.content) {
		return jsonData.choices[0].delta.content;
	}
	// Some Workers AI streams send { response: "..." } inside "result"
	if (typeof jsonData.result?.response === "string") {
		return jsonData.result.response;
	}
	return "";
}

// ---------- Main send function ----------
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages or while processing
	if (message === "" || isProcessing) return;

	// Lock UI
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Hide welcome screen on first user message
	updateWelcomeScreen();

	// Show typing indicator
	typingIndicator.classList.add("visible");
	scrollToBottom();

	// Add to history
	chatHistory.push({ role: "user", content: message });

	try {
		// Create the assistant bubble that we'll stream into
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message bot";
		assistantMessageEl.textContent = "";
		messagesList.appendChild(assistantMessageEl);
		scrollToBottom();

		// Send request
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: chatHistory }),
		});

		if (!response.ok) {
			throw new Error(`Failed to get response (${response.status})`);
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Stream and parse
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";
		let sawDone = false;

		const flush = () => {
			assistantMessageEl.textContent = responseText;
			scrollToBottom();
		};

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Flush any remaining complete events
				const parsed = consumeSseEvents(buffer + "\n\n");
				for (const data of parsed.events) {
					if (data === "[DONE]") break;
					try {
						const content = extractContent(JSON.parse(data));
						if (content) {
							responseText += content;
							flush();
						}
					} catch (e) {
						console.error("Error parsing final SSE data:", e, data);
					}
				}
				break;
			}

			// Decode chunk
			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;

			for (const data of parsed.events) {
				if (data === "[DONE]") {
					sawDone = true;
					buffer = "";
					break;
				}
				try {
					const content = extractContent(JSON.parse(data));
					if (content) {
						responseText += content;
						flush();
					}
				} catch (e) {
					console.error("Error parsing SSE data:", e, data);
				}
			}

			if (sawDone) break;
		}

		// If nothing streamed, remove the empty bubble
		if (responseText.length === 0) {
			assistantMessageEl.textContent =
				"⚠️ No response received from the model.";
			responseText = assistantMessageEl.textContent;
		}

		// Save to history
		chatHistory.push({ role: "assistant", content: responseText });
	} catch (error) {
		console.error("Error:", error);
		// Replace / add an error bubble
		const errorEl = document.createElement("div");
		errorEl.className = "message bot";
		errorEl.textContent =
			"Sorry, there was an error processing your request.";
		messagesList.appendChild(errorEl);
		scrollToBottom();
	} finally {
		// Hide typing indicator
		typingIndicator.classList.remove("visible");

		// Re-enable input
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		updateSendButton();
		userInput.focus();
	}
}

// ---------- Copy button (for the code snippet in sidebar) ----------
const copyBtn = document.getElementById("copyBtn");
if (copyBtn) {
	copyBtn.addEventListener("click", () => {
		const codeElement = document.querySelector(".code-block code");
		if (!codeElement) return;
		navigator.clipboard
			.writeText(codeElement.innerText)
			.then(() => {
				const original = copyBtn.textContent;
				copyBtn.textContent = "Copied!";
				setTimeout(() => (copyBtn.textContent = original), 1500);
			})
			.catch(() => alert("Press Ctrl+C to copy"));
	});
}

// ---------- Init ----------
(function init() {
	updateWelcomeScreen();
	updateSendButton();
	userInput.focus();
})();