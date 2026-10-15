interface Env {
  AI: {
    run(
      model: string,
      inputs: Record<string, unknown>
    ): Promise<ReadableStream | Record<string, unknown>>;
  };
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `
You are FlyTripVisa AI, the official AI travel and visa assistant.
Help users with visa information, travel planning, flights, hotels,
and general questions. Be accurate, friendly, and clear.
Do not claim that a visa has been approved or a booking has been
completed unless a connected service confirms it.
`;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight for API requests
    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Health check
    if (url.pathname === "/api/health" && request.method === "GET") {
      return Response.json(
        {
          ok: true,
          service: "FlyTripVisa AI",
          timestamp: new Date().toISOString(),
        },
        { headers: corsHeaders() }
      );
    }

    // AI chat endpoint
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    // Reject unsupported API methods
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "API endpoint not found or method not allowed." },
        { status: 404, headers: corsHeaders() }
      );
    }

    // Serve existing website files without changing the UI
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as {
      messages?: ChatMessage[];
    };

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json(
        { error: "Please provide a non-empty messages array." },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Validate incoming messages and limit payload size
    if (body.messages.length > 50) {
      return Response.json(
        { error: "Too many messages. Please start a new conversation." },
        { status: 400, headers: corsHeaders() }
      );
    }

    const messages: ChatMessage[] = body.messages.map((message) => {
      if (
        !message ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" ||
        message.content.length > 12000
      ) {
        throw new Error("Invalid chat message format.");
      }

      return {
        role: message.role,
        content: message.content,
      };
    });

    const inputMessages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages,
    ];

    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fp8",
      {
        messages: inputMessages,
        stream: true,
      }
    );

    // Pass through a native streaming response from Workers AI
    if (result instanceof ReadableStream) {
      return new Response(result, {
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Fallback if the model returns a regular object
    return Response.json(result, {
      headers: corsHeaders(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error";

    return Response.json(
      {
        error: "Unable to process your message.",
        details: message,
      },
      {
        status: message.includes("Invalid chat message") ? 400 : 500,
        headers: corsHeaders(),
      }
    );
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}