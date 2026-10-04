// Точка входа Worker'а. Пока каркас: маршруты и обработчики появятся по ADR-0005.

// Тип Env генерируется из wrangler.jsonc: `npm run types` (worker-configuration.d.ts).

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },

  async queue(_batch: MessageBatch<unknown>, _env: Env): Promise<void> {},

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {},
} satisfies ExportedHandler<Env, unknown>;
