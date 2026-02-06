/*
  api/full.js - v4.0.0 - 2026-02-06
  Purpose: AI Visibility Analysis - How AI systems perceive and represent your brand
  ENV Required: OPENAI_API_KEY
  
  Changes from v3.7.0:
  - Replaced axios with native fetch (fixes Vercel module error)
  - Updated language from "SEO" to "AI visibility/brand perception"
  - Default model: gpt-4o-mini (faster, still high quality)
*/

import OpenAI from "openai";
import * as cheerio from "cheerio";

export const config = {
  maxDuration: 300
};

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL parameter" });

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasOpenAI) {
    return res.status(200).json(fallbackPayload(url, "missing_api_key"));
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Fetch website content
    let contentData = {};
    let fetchMeta = { mode: "direct", reason: "" };

    try {
      const fetched = await fetchWebsiteContent(url);
      contentData = fetched.contentData;
      fetchMeta = fetched.fetchMeta;
    } catch (fetchError) {
      return res.status(200).json(fallbackPayload(url, `fetch_failed: ${fetchError.message}`));
    }

    const analysisPrompt = buildAnalysisPrompt(url, contentData);

    // Call OpenAI
    let aiAnalysis = null;
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 4000,
        messages: [
          {
            role: "system",
            content: "You are an expert AI visibility analyst specializing in how AI systems (ChatGPT, Claude, Gemini, Perplexity, Copilot) interpret and represent brands. Return ONLY valid JSON with no markdown formatting."
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
    if (!aiAnalysis || !Array.isArray(aiAnalysis.needsAttention) || aiAnalysis.needsAttention.length < 5) {
      return res.status(200).json(fallbackPayload(url, "invalid_ai_response"));
    }

    // Return successful response
    return res.status(200).json({
      success: true,
      brandProfile: aiAnalysis.brandProfile || null,
      overallScore: aiAnalysis.overallScore || null,
      whatsWorking: aiAnalysis.whatsWorking || [],
      needsAttention: aiAnalysis.needsAttention || [],
      engineInsights: aiAnalysis.engineInsights || {},
      meta: {
        analyzedAt: new Date().toISOString(),
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        url,
        fetchMode: fetchMeta.mode
      }
    });
  } catch (error) {
    return res.status(200).json(fallbackPayload(url, `handler_error: ${error.message}`));
  }
}

/* -------------------------
   FETCH LAYER (Native fetch)
-------------------------- */

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"
];

function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function browserHeaders() {
  return {
    "User-Agent": pickUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive"
  };
}

async function fetchWebsiteContent(targetUrl) {
  const absoluteUrl = ensureProtocol(targetUrl);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(absoluteUrl, {
      headers: browserHeaders(),
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return {
      contentData: parseContentData(absoluteUrl, html),
      fetchMeta: { mode: "direct", reason: "" }
    };

  } catch (error) {
    // Try Jina proxy as fallback
    try {
      const proxyUrl = `https://r.jina.ai/${absoluteUrl}`;
      const proxyResponse = await fetch(proxyUrl, {
        headers: { "User-Agent": pickUA() }
      });

      if (proxyResponse.ok) {
        const text = await proxyResponse.text();
        return {
          contentData: parseContentData(absoluteUrl, wrapTextAsHtml(text, absoluteUrl), { forceTextFromBody: text }),
          fetchMeta: { mode: "proxy", reason: error.message }
        };
      }
    } catch (proxyError) {
      // Both failed
    }

    throw new Error(`Unable to fetch: ${error.message}`);
  }
}

function parseContentData(url, html, opts = {}) {
  const $ = cheerio.load(html || "");
  const hostname = new URL(ensureProtocol(url)).hostname;

  const bodyText = opts.forceTextFromBody || $("body").text() || "";
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
    .replace(/>/g, "&gt;");
}

/* ---------- ANALYSIS PROMPT ---------- */
function buildAnalysisPrompt(url, contentData) {
  return `
You are an AI visibility analyst. Analyze how AI systems (ChatGPT, Claude, Gemini, Perplexity, Copilot) would interpret and represent this brand based on their website content.

URL: ${url}
Title: ${contentData.pageTitle || "Not found"}
Meta Description: ${contentData.metaDescription || "Not found"}
Has Schema Markup: ${contentData.hasSchema ? "Yes" : "No"}

Page Content:
${(contentData.textContent || "").slice(0, 8000)}

Return a JSON object with this EXACT structure:

{
  "brandProfile": {
    "name": "Brand name as AI would identify it",
    "industry": "Primary industry/sector",
    "positioning": "How AI would describe their market position (1-2 sentences)",
    "audience": "Target audience as AI would infer",
    "offerings": ["Product/service 1", "Product/service 2", "Product/service 3"],
    "differentiators": ["What makes them unique 1", "What makes them unique 2"]
  },
  "whatsWorking": [
    "Specific strength that helps AI understand and represent this brand accurately",
    "Another specific strength with concrete example from the content"
  ],
  "needsAttention": [
    {
      "issue": "Specific issue affecting AI interpretation",
      "priority": "critical",
      "impact": "How this affects AI representation of the brand",
      "fix": "Specific recommendation to address this"
    }
  ],
  "engineInsights": {
    "ChatGPT": {
      "score": 65,
      "brandPerception": "How ChatGPT would describe this brand to users",
      "strengths": ["Strength 1", "Strength 2"],
      "gaps": ["Gap 1", "Gap 2"],
      "topRecommendation": "Single most impactful improvement for ChatGPT"
    },
    "Claude": {
      "score": 70,
      "brandPerception": "How Claude would describe this brand",
      "strengths": ["Strength 1", "Strength 2"],
      "gaps": ["Gap 1", "Gap 2"],
      "topRecommendation": "Single most impactful improvement for Claude"
    },
    "Gemini": {
      "score": 60,
      "brandPerception": "How Gemini would describe this brand",
      "strengths": ["Strength 1", "Strength 2"],
      "gaps": ["Gap 1", "Gap 2"],
      "topRecommendation": "Single most impactful improvement for Gemini"
    },
    "Copilot": {
      "score": 55,
      "brandPerception": "How Copilot would describe this brand",
      "strengths": ["Strength 1", "Strength 2"],
      "gaps": ["Gap 1", "Gap 2"],
      "topRecommendation": "Single most impactful improvement for Copilot"
    },
    "Perplexity": {
      "score": 68,
      "brandPerception": "How Perplexity would describe this brand",
      "strengths": ["Strength 1", "Strength 2"],
      "gaps": ["Gap 1", "Gap 2"],
      "topRecommendation": "Single most impactful improvement for Perplexity"
    }
  }
}

CRITICAL RULES:
1. Return ONLY valid JSON - no markdown, no code blocks, no explanations
2. Be SPECIFIC to this brand - no generic advice
3. Reference actual content from the page
4. Provide 3-5 items in whatsWorking
5. Provide 8-15 items in needsAttention with mix of priorities: "critical" (2-3), "strategic" (3-5), "incremental" (3-7)
6. Each engine insight must be specific to how that AI system processes content
7. Scores should reflect realistic assessment (most sites score 45-75)
`.trim();
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
    brandProfile: {
      name: new URL(ensureProtocol(url)).hostname.replace('www.', ''),
      industry: "Unknown",
      positioning: "Unable to analyze - please try again",
      audience: "Unknown",
      offerings: [],
      differentiators: []
    },
    whatsWorking: [
      "Analysis temporarily unavailable"
    ],
    needsAttention: [
      {
        issue: "Full analysis could not be completed",
        priority: "critical",
        impact: "Unable to assess AI visibility",
        fix: "Please try again or contact support"
      }
    ],
    engineInsights: {
      ChatGPT: { score: null, brandPerception: "Analysis unavailable", strengths: [], gaps: [], topRecommendation: "Try again" },
      Claude: { score: null, brandPerception: "Analysis unavailable", strengths: [], gaps: [], topRecommendation: "Try again" },
      Gemini: { score: null, brandPerception: "Analysis unavailable", strengths: [], gaps: [], topRecommendation: "Try again" },
      Copilot: { score: null, brandPerception: "Analysis unavailable", strengths: [], gaps: [], topRecommendation: "Try again" },
      Perplexity: { score: null, brandPerception: "Analysis unavailable", strengths: [], gaps: [], topRecommendation: "Try again" }
    },
    meta: { url, mode: "fallback", reason }
  };
}
