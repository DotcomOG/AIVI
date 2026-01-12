/*
  api/full.js - v3.7.0 — PRODUCTION VERSION
  Purpose: Comprehensive AI SEO analysis (25 opportunities minimum)
  ENV Required: OPENAI_API_KEY

  Key change (functionality):
  - Stop "bot fingerprint" blocks by using consistent browser-like headers,
    rotating realistic User-Agents, and adding a secondary fetch strategy
    for 403/429/WAF-blocked sites.

  Notes:
  - This file does NOT change your response shape.
  - If your other endpoints (api/score.js, report generator) still use default fetch/axios,
    apply the SAME fetchHTML() helper there too.
*/

import OpenAI from "openai";
import * as cheerio from "cheerio";
import axios from "axios";

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL parameter" });

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasOpenAI) {
    return res.status(200).json(fallbackPayload(url, "missing_api_key"));
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Fetch website content with bot-avoidance + fallback
    let contentData = {};
    let fetchMeta = { mode: "direct", reason: "" };

    try {
      const fetched = await fetchWebsiteContent(url);
      contentData = fetched.contentData;
      fetchMeta = fetched.fetchMeta;
    } catch (fetchError) {
      return res.status(200).json(fallbackPayload(url, `fetch_failed: ${fetchError.message}`));
    }

    const analysisPrompt = buildEnhancedPrompt(url, contentData);

    // Call OpenAI
    let aiAnalysis = null;
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4-turbo",
        temperature: 0.3,
        max_tokens: 4000,
        messages: [
          {
            role: "system",
            content: "You are an expert AI SEO analyst. Return ONLY valid JSON with no markdown formatting."
          },
          { role: "user", content: analysisPrompt }
        ]
      });

      const raw = completion?.choices?.[0]?.message?.content?.trim() || "";
      const jsonString = extractJSONObject(raw);

      if (jsonString) {
        aiAnalysis = JSON.parse(jsonString);
      }
    } catch (aiError) {
      return res.status(200).json(fallbackPayload(url, `ai_failed: ${aiError.message}`));
    }

    // Validate AI response
    if (!aiAnalysis || !Array.isArray(aiAnalysis.needsAttention) || aiAnalysis.needsAttention.length < 10) {
      return res.status(200).json(fallbackPayload(url, "invalid_ai_response"));
    }

    // Calculate score
    const score = calculateScore(contentData, aiAnalysis);

    // Return successful response (whatsWorking intentionally empty)
    return res.status(200).json({
      success: true,
      score,
      needsAttention: aiAnalysis.needsAttention.slice(0, 25),
      engineInsights: aiAnalysis.engineInsights?.slice(0, 5) || [],
      whatsWorking: [],
      metrics: {
        technical: {
          imagesWithAlt: contentData.imagesWithAlt || 0,
          totalImages: contentData.images || 0,
          internalLinks: contentData.internalLinks || 0,
          hasSchema: contentData.hasSchema || false,
          metaDescription: !!contentData.metaDescription
        }
      },
      meta: {
        analyzedAt: new Date().toISOString(),
        model: process.env.OPENAI_MODEL || "gpt-4-turbo",
        url,
        fetchMode: fetchMeta.mode,
        fetchReason: fetchMeta.reason
      }
    });
  } catch (error) {
    return res.status(200).json(fallbackPayload(url, `handler_error: ${error.message}`));
  }
}

/* -------------------------
   BOT-AVOIDANCE FETCH LAYER
-------------------------- */

const UA_POOL = [
  // Chrome (Windows)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Chrome (Mac)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Safari (Mac)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  // Edge (Windows)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
];

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

// A realistic baseline header set. (No "sec-ch-ua" here; many WAFs don’t require it,
// but they DO penalize obviously-bot headers like axios/undici defaults.)
function browserHeaders(targetUrl) {
  const u = new URL(ensureProtocol(targetUrl));
  return {
    "User-Agent": pickUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": `${u.origin}/`
  };
}

// Detect typical block responses (very pragmatic; not perfect)
function looksBlocked(status, body) {
  const s = Number(status || 0);
  if (s === 403 || s === 429) return true;
  const t = String(body || "").toLowerCase();
  return (
    t.includes("access denied") ||
    t.includes("request blocked") ||
    t.includes("unusual traffic") ||
    t.includes("verify you are human") ||
    t.includes("captcha") ||
    t.includes("cloudflare") ||
    t.includes("akamai") ||
    t.includes("imperva") ||
    t.includes("incapsula")
  );
}

async function fetchHtmlDirect(targetUrl) {
  const headers = browserHeaders(targetUrl);

  // axios automatically sets Host; we keep the rest consistent
  const resp = await axios.get(targetUrl, {
    headers,
    timeout: 20000,
    maxRedirects: 5,
    responseType: "text",
    validateStatus: () => true
  });

  return resp;
}

// Secondary fetch path: use a text-render proxy when direct fetch is blocked.
// This avoids your server identifying as axios/undici to the target site.
// If the proxy fails, we fall back to direct failure handling.
async function fetchHtmlViaJina(targetUrl) {
  // r.jina.ai expects a full URL with protocol
  const absolute = ensureProtocol(targetUrl);
  const proxyUrl = `https://r.jina.ai/http://${absolute.replace(/^https?:\/\//i, "")}`;

  const resp = await axios.get(proxyUrl, {
    headers: {
      "User-Agent": pickUA(),
      "Accept": "text/plain,*/*;q=0.9",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive"
    },
    timeout: 25000,
    maxRedirects: 3,
    responseType: "text",
    validateStatus: () => true
  });

  return resp;
}

async function fetchWebsiteContent(targetUrl) {
  const absoluteUrl = ensureProtocol(targetUrl);

  // 1) Direct attempt
  const direct = await fetchHtmlDirect(absoluteUrl);
  const directBody = direct?.data || "";

  if (direct.status >= 200 && direct.status < 400 && !looksBlocked(direct.status, directBody)) {
    return {
      contentData: parseContentData(absoluteUrl, directBody),
      fetchMeta: { mode: "direct", reason: "" }
    };
  }

  // 2) If blocked or bad status, try proxy strategy
  const blocked = looksBlocked(direct.status, directBody);
  if (blocked || direct.status === 0 || direct.status >= 400) {
    const proxy = await fetchHtmlViaJina(absoluteUrl);

    if (proxy.status >= 200 && proxy.status < 400) {
      // Proxy returns text, not true HTML sometimes. Still useful for LLM.
      const rawText = String(proxy.data || "");
      const asHtml = wrapTextAsHtml(rawText, absoluteUrl);

      return {
        contentData: parseContentData(absoluteUrl, asHtml, { forceTextFromBody: rawText }),
        fetchMeta: {
          mode: "proxy",
          reason: blocked ? `blocked_direct_${direct.status}` : `direct_http_${direct.status}`
        }
      };
    }
  }

  // If we get here, both paths failed
  throw new Error(`Blocked or unreachable (direct=${direct.status})`);
}

function parseContentData(url, html, opts = {}) {
  const $ = cheerio.load(html || "");
  const hostname = new URL(ensureProtocol(url)).hostname;

  // If we had to fetch via a text proxy, we may already have clean text.
  const bodyText =
    opts.forceTextFromBody ||
    $("body").text() ||
    "";

  const textContent = String(bodyText).replace(/\s+/g, " ").trim();

  return {
    textContent,
    pageTitle: $("title").text().trim(),
    metaDescription: $('meta[name="description"]').attr("content")?.trim() || "",
    headings: $("h1, h2, h3")
      .map((i, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .join(" | ")
      .slice(0, 2000),
    images: $("img").length,
    imagesWithAlt: $("img[alt]").length,
    internalLinks: $(`a[href^='/'], a[href*='${hostname}']`).length,
    hasSchema: $("script[type='application/ld+json']").length > 0
  };
}

function wrapTextAsHtml(text, url) {
  // Minimal wrapper so cheerio parsing still works in a predictable way
  const safe = String(text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><title>${escapeHtml(url)}</title></head><body><pre>${safe}</pre></body></html>`;
}

function ensureProtocol(u) {
  const s = String(u || "").trim();
  if (!s) return s;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- PROMPT ---------- */
function buildEnhancedPrompt(url, contentData) {
  return `
You are an expert AI SEO specialist analyzing this website for AI search engine optimization.

URL: ${url}
Title: ${contentData.pageTitle || "Not found"}
Meta Description: ${contentData.metaDescription || "MISSING"}

TECHNICAL SEO:
- Images: ${contentData.imagesWithAlt || 0}/${contentData.images || 0} have alt text
- Schema Markup: ${contentData.hasSchema ? "Present" : "MISSING"}
- Internal Links: ${contentData.internalLinks || 0}

Sample Content: ${(contentData.textContent || "").slice(0, 6000)}

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON - NO markdown, NO code blocks, NO explanations
2. Provide EXACTLY 25 items in "needsAttention" array
3. Provide EXACTLY 5 items in "engineInsights" array

JSON Structure:
{
  "needsAttention": [
    "[PRIORITY: High] Issue title. Solution: Specific steps to fix. Impact: Expected measurable outcome.",
    "... 25 total items ..."
  ],
  "engineInsights": [
    "ChatGPT: Specific optimization strategy",
    "Claude: Specific optimization strategy",
    "Gemini: Specific optimization strategy",
    "Perplexity: Specific optimization strategy",
    "Copilot: Specific optimization strategy"
  ]
}

PRIORITY DISTRIBUTION:
- High: 5-7 critical issues
- Medium: 10-12 important improvements
- Low: 8-10 incremental enhancements

Focus on AI-specific optimizations, not generic SEO advice. Be specific and actionable.

COUNT YOUR ITEMS - YOU MUST HAVE EXACTLY 25 IN needsAttention ARRAY!
`.trim();
}

/* ---------- SCORE CALCULATION ---------- */
function calculateScore(contentData, aiAnalysis) {
  let score = 55; // Base score

  if (contentData.metaDescription) score += 5;
  if (contentData.hasSchema) score += 8;

  if (contentData.images > 0) {
    const altCoverage = contentData.imagesWithAlt / contentData.images;
    score += altCoverage * 10;
  }

  if (contentData.internalLinks > 10) score += 5;

  const issues = aiAnalysis.needsAttention?.length || 0;
  score -= Math.min(issues * 0.8, 20);

  return Math.max(20, Math.min(100, Math.round(score)));
}

/* ---------- HELPERS ---------- */
function extractJSONObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1).trim();
  }
  return "";
}

function fallbackPayload(url, reason = "fallback") {
  return {
    success: false,
    score: 50,
    needsAttention: [
      "[PRIORITY: High] Analysis Unavailable: Unable to complete AI analysis. Solution: Verify API configuration and site accessibility. Impact: Full visibility assessment needed.",
      "[PRIORITY: High] Missing Schema Markup: Implement structured data for better AI understanding. Solution: Add JSON-LD schema. Impact: Improved content interpretation.",
      "[PRIORITY: Medium] Technical Audit Required: Basic SEO factors need verification. Solution: Manual review of meta tags and structure. Impact: Better baseline.",
      "[PRIORITY: Medium] Content Structure: Review heading hierarchy. Solution: Use semantic HTML. Impact: Improved comprehension.",
      "[PRIORITY: Medium] Internal Linking: Strengthen site structure. Solution: Add contextual links. Impact: Better navigation.",
      "[PRIORITY: Low] Performance Review: Check page speed. Solution: Optimize images and scripts. Impact: Faster load times.",
      "[PRIORITY: Low] Mobile Optimization: Ensure responsive design. Solution: Test on mobile devices. Impact: Better mobile experience."
    ],
    engineInsights: [
      "ChatGPT: Ensure clear content structure with proper headings",
      "Claude: Focus on comprehensive, well-organized information",
      "Gemini: Optimize technical SEO and page performance",
      "Perplexity: Build authority through quality citations",
      "Copilot: Implement semantic HTML and accessibility"
    ],
    whatsWorking: [],
    meta: { url, mode: "fallback", reason }
  };
}
