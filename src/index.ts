export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API route
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  try {
    const { messages } = await request.json();

    const stream = await env.AI.run(
      "@cf/meta/llama-3-8b-instruct",
      { messages, stream: true }
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}