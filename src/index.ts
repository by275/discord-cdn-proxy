interface Env { DISCORD_TOKEN: string, CHANNELS?: string[], KV?: KVNamespace }

interface RefreshedResponse { refreshed_urls?: { original?: string, refreshed?: string }[] }

interface CachedURL { href: string, expires: Date };

// There's a high chance that the instance will not be recycled between calls, especially under heavy load.
// We can extract previously saved results from the global cache object below.
const cache = new Map<string, CachedURL>();

function handleOPTIONS(request: Request) {
	// Adjust as desired: GET, POST, PATCH, DELETE, HEAD, OPTIONS
	const methods = "GET, OPTIONS";
	const origin = request.headers.get("Origin");
	const requestMethod = request.headers.get("Access-Control-Request-Method");
	const requestHeaders = request.headers.get("Access-Control-Request-Headers");

	// Combined condition for pre-flight CORS request
	if (origin && requestMethod && requestHeaders) {
		// Handle CORS pre-flight request.
		return new Response(null, {
			headers: {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Methods": methods,
				"Access-Control-Allow-Headers": requestHeaders,
				"Access-Control-Max-Age": "86400", // Cached pre-flight response for 24 hours
			}
		})
	}

	// Handle standard OPTIONS request.
	return new Response(null, {
		headers: {
			"Allow": methods,
		}
	});
}

function withCORS(request: Request, response: Response): Response {
	// Simplified to set CORS only if origin is present
	const origin = request.headers.get("Origin");
	if (origin) {
		response.headers.set("Access-Control-Allow-Origin", origin);
	}
	return response;
}

function redirectResponse(request: Request, href: string, expires: Date, custom: 'original' | 'refreshed' | 'memory' | 'cached') {
	if (custom !== 'original' && custom !== 'refreshed') {
		const redirectUrl = new URL(href);
		const requestParams = new URL(request.url).searchParams;
		for (const key of ['ex', 'is', 'hm']) {
			const value = redirectUrl.searchParams.get(key);
			if (value !== null) requestParams.set(key, value);
		}
		redirectUrl.search = requestParams.toString()
		href = redirectUrl.href;
	}
	// 302 Found https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302
	const response = new Response('', { status: 302, statusText: 'Found' });
	response.headers.set('Location', href);
	response.headers.set('Expires', expires.toUTCString());
	response.headers.set('x-discord-cdn-proxy', custom);

	return withCORS(request, response); // Use existing function to apply CORS headers
}

function attachmentUrl(url: URL): string {
	// Return URL with the replacement for discord CDN
	return url.href.replace(url.origin, "https://cdn.discordapp.com")
}

function passthroughParams(url: URL): URLSearchParams {
	const params = new URLSearchParams();
	for (const [key, value] of url.searchParams) {
		if (key !== 'ex' && key !== 'is' && key !== 'hm')
			params.set(key, value);
	}
	return params;
}

function getCacheKey(pathname: string, params: URLSearchParams): string {
	const base = pathname.split('/').slice(2, 4).join(':');
	if (params.size === 0)
		return base;

	const suffix = Array.from(params.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');

	return `${base}:${suffix}`;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext
	): Promise<Response> {
		try {
			if (request.method === 'OPTIONS')
				return handleOPTIONS(request)

			if (!env.DISCORD_TOKEN)
				return withCORS(request, Response.json(`DISCORD_TOKEN is not configured`, { status: 400 }));

			const requestUrl = new URL(request.url);

			// Validate pathname format: /attachments/{channelID}/{attachmentID}/filename.ext
			const pathname = requestUrl.pathname;
			if (!/^\/attachments\/\d+\/\d+\/.*$/.test(pathname))
				return withCORS(request, Response.json(`Invalid Path`, { status: 400 }));

			// If CHANNELS defined ensure we that provided channel is allowed
			const channel = pathname.split('/')[2];
			if (env.CHANNELS && !env.CHANNELS.includes(channel))
				return withCORS(request, Response.json(`Channel ${channel} is not allowed`, { status: 400 }));

			const params = requestUrl.searchParams;
			const exParam = params.get("ex");
			if (exParam && params.get("is") && params.get("hm")) {
				const expires = new Date(parseInt(exParam, 16) * 1000);
				if (expires.getTime() > Date.now())
					return redirectResponse(request, attachmentUrl(requestUrl), expires, 'original');
			}

			const additionalParams = passthroughParams(requestUrl);
			const cacheKey = getCacheKey(pathname, additionalParams);

			// Check in-memory cache first
			const cachedUrl: CachedURL | undefined = cache.get(cacheKey);
			if (cachedUrl && cachedUrl.expires.getTime() > Date.now())
				return redirectResponse(request, cachedUrl.href, cachedUrl.expires, 'memory');

			// Check kv namespace (if configured)
			if (env.KV) {
				const cachedUrl: CachedURL | null = await env.KV.get(cacheKey, { type: 'json' });

				if (cachedUrl) {
					cachedUrl.expires = new Date(cachedUrl.expires);
					if (cachedUrl.expires.getTime() > Date.now()) {
						// Save to in-memory cache
						cache.set(cacheKey, cachedUrl);
						return redirectResponse(request, cachedUrl.href, cachedUrl.expires, 'cached');
					}
				}
			}

			const payload = {
				method: 'POST',
				headers: {
					'Authorization': `${env.DISCORD_TOKEN}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ attachment_urls: [attachmentUrl(requestUrl)] })
			};

			const response = await fetch('https://discord.com/api/v9/attachments/refresh-urls', payload);

			// If failed return original Discord API response back
			if (response.status !== 200)
				return withCORS(request, response);

			const json = await response.json<RefreshedResponse>();

			if (Array.isArray(json?.refreshed_urls) && json.refreshed_urls[0].refreshed) {
				const refreshedUrl = new URL(json.refreshed_urls[0].refreshed);
				for (const [key, value] of additionalParams)
					refreshedUrl.searchParams.set(key, value);

				// Convert from hex and add seconds
				const expires = new Date(parseInt(refreshedUrl.searchParams.get('ex')!, 16) * 1000);

				const cachedUrl: CachedURL = { href: refreshedUrl.href, expires };

				// Save to in-memory cache
				cache.set(cacheKey, cachedUrl);

				// Save to kv namespace (if configured)
				if (env.KV)
					ctx.waitUntil(env.KV.put(cacheKey, JSON.stringify(cachedUrl), {
						expiration: expires.getTime() / 1000,
					}));

				return redirectResponse(request, refreshedUrl.href, expires, 'refreshed');
			}

			// Return Discord API json which does not have expected data
			return withCORS(request, Response.json(json, { status: 400 }));
		} catch (ex: any) {
			console.error(`Exception`, ex);
			return withCORS(request, new Response(ex.message || ex, { status: 500 }));
		}
	}
};
