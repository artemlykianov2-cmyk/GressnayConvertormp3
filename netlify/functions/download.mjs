const MAX_BYTES = 5 * 1024 * 1024; // Keep below Netlify's buffered response limit.
const ALLOWED_PROTOCOL = "https:";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "Используй POST-запрос." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Некорректный JSON." }, 400);
  }

  const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
  if (!rawUrl) return json({ error: "Не указана ссылка." }, 400);

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return json({ error: "Некорректная ссылка." }, 400);
  }

  if (url.protocol !== ALLOWED_PROTOCOL || url.username || url.password) {
    return json({ error: "Разрешены только HTTPS-ссылки." }, 400);
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    host === "youtube.com" || host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host === "soundcloud.com" || host.endsWith(".soundcloud.com") ||
    host === "tiktok.com" || host.endsWith(".tiktok.com")
  ) {
    return json({
      error: "Ссылки на страницы YouTube/SoundCloud/TikTok не поддерживаются. Загрузи аудиофайл, на который у тебя есть права, или используй официальный способ скачивания платформы."
    }, 400);
  }

  // Security: only fetch hosts explicitly configured by the site owner.
  // In Netlify: Site configuration → Environment variables →
  // ALLOWED_MEDIA_HOSTS = example.com,cdn.example.org
  const allowedHosts = (Netlify.env.get("ALLOWED_MEDIA_HOSTS") || "")
    .split(",")
    .map(x => x.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);

  if (!allowedHosts.includes(host)) {
    return json({
      error: "Домен не разрешён. Владелец сайта должен добавить его в ALLOWED_MEDIA_HOSTS в настройках Netlify."
    }, 403);
  }

  try {
    // Do not follow redirects: this prevents an allowlisted host redirecting to another host.
    const upstream = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "GressnayConvertormp3/1.0" },
      signal: AbortSignal.timeout(15000),
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: "Источник перенаправляет на другой адрес. Используй прямую ссылку на файл." }, 400);
    }
    if (!upstream.ok) {
      return json({ error: `Источник вернул HTTP ${upstream.status}.` }, 502);
    }

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    if (!(contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType === "application/octet-stream")) {
      return json({ error: "По ссылке не обнаружен прямой аудио-/видеофайл. Возможно, это HTML-страница." }, 415);
    }

    const declaredLength = Number(upstream.headers.get("content-length") || 0);
    if (declaredLength > MAX_BYTES) {
      return json({ error: "Файл больше 5 МБ. Этот простой Netlify endpoint ограничен по размеру." }, 413);
    }

    const data = await upstream.arrayBuffer();
    if (!data.byteLength) return json({ error: "Источник вернул пустой файл." }, 502);
    if (data.byteLength > MAX_BYTES) {
      return json({ error: "Файл больше 5 МБ. Этот простой Netlify endpoint ограничен по размеру." }, 413);
    }

    const pathPart = url.pathname.split("/").filter(Boolean).pop() || "media-file";
    const filename = pathPart.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "media-file";
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(data.byteLength),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return json({
      error: error?.name === "TimeoutError"
        ? "Источник отвечает слишком долго."
        : "Не удалось получить файл. Проверь прямую ссылку и доступность источника."
    }, 502);
  }
}
