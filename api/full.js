/* 
  api/full.js - v3.5.0 — WORKING VERSION
  Purpose: Comprehensive AI SEO analysis (25 opportunities minimum)
  ENV Required: OPENAI_API_KEY
*/

import OpenAI from "openai";
import * as cheerio from "cheerio";
import axios from "axios";

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL parameter" });

  // Check if we have OpenAI key
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  console.log("API Key status:", { hasOpenAI });

  if (!hasOpenAI) {
    console.error("OPENAI_API_KEY not found");
    return res.status(200).json(fallbackPayload(url, "missing_api_key"));
  }

  try {
    // Initialize OpenAI inside try block
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Fetch website content
    let contentData = {};
    try {
      const htmlResp = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AIVIndexBot/1.0)" },
        timeout: 15000
      });

      const $ = cheerio.load(htmlResp.data);
      contentData = {
        textContent: $("body").text().replace(/\s+/g, " ").trim(),
        pageTitle: $("title").text().trim(),
        metaDescription: $('meta[name="description"]').attr("content")?.trim() || "",
        headings: $("h1, h2, h3").map((i, el) => $(el).text().replace(/\s+/g, " ").trim()).get().join(" | ").slice(0, 2000),
        images: $("img").length,
        imagesWithAlt: $("img[alt]").length,
        internalLinks: $("a[href^='/'], a[href*='" + new URL(url).hostname + "']").length,
        hasSchema: $("script[type='application/ld+json']").length > 0
      };
    } catch (fetchError) {
      console.error("Failed to fetch website:", fetchError.message);
      return res.status(200).json(fallbackPayload(url, "fetch_failed"));
    }

    // Build AI prompt
    const analysisPrompt = buildEnhancedPrompt(url, contentData);

    // Call OpenAI
    let aiAnalysis = null;
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4-turbo",
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
      } else {
        console.error("Could not extract JSON from AI response");
      }
    } catch (aiError) {
      console.error("AI analysis failed:", aiError.message);
      return res.status(200).json(fallbackPayload(url, "ai_failed"));
    }

    // Validate AI response
    if (!aiAnalysis || !Array.isArray(aiAnalysis.needsAttention) || aiAnalysis.needsAttention.length < 10) {
      console.error("AI returned invalid/incomplete data");
      return res.status(200).json(fallbackPayload(url, "invalid_ai_response"));
    }

    // Calculate score
    const score = calculateScore(contentData, aiAnalysis);

    // Return successful response (NO whatsWorking - deleted per user request)
    return res.status(200).json({
      success: true,
      score,
      needsAttention: aiAnalysis.needsAttention.slice(0, 25),
      engineInsights: aiAnalysis.engineInsights?.slice(0, 5) || [],
      whatsWorking: [], // Empty array so frontend doesn't break
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
        model: "gpt-4-turbo",
        url
      }
    });

  } catch (error) {
    console.error("Handler error:", error);
    return res.status(200).json(fallbackPayload(url, error.message));
  }
}

/* ---------- ENHANCED PROMPT ---------- */
function buildEnhancedPrompt(url, contentData) {
  return `
You are an expert AI SEO specialist analyzing this website for AI search engine optimization.

URL: ${url}
Title: ${contentData.pageTitle || 'Not found'}
Meta Description: ${contentData.metaDescription || 'MISSING'}

TECHNICAL SEO:
- Images: ${contentData.imagesWithAlt || 0}/${contentData.images || 0} have alt text
- Schema Markup: ${contentData.hasSchema ? 'Present' : 'MISSING'}
- Internal Links: ${contentData.internalLinks || 0}

Sample Content: ${(contentData.textContent || '').slice(0, 6000)}

CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON - NO markdown, NO code blocks, NO explanations
2. Provide EXACTLY 25 items in "needsAttention" array
3. Provide EXACTLY 5 items in "engineInsights" array

JSON Structure:
{
  "needsAttention": [
    "[PRIORITY: High] Issue title. Solution: Specific steps to fix. Impact: Expected measurable outcome.",
    "[PRIORITY: High] Second issue...",
    "[PRIORITY: High] Third issue...",
    "[PRIORITY: High] Fourth issue...",
    "[PRIORITY: High] Fifth issue...",
    "[PRIORITY: Medium] Sixth issue...",
    "[PRIORITY: Medium] Seventh issue...",
    "[PRIORITY: Medium] Eighth issue...",
    "[PRIORITY: Medium] Ninth issue...",
    "[PRIORITY: Medium] Tenth issue...",
    "[PRIORITY: Medium] Eleventh issue...",
    "[PRIORITY: Medium] Twelfth issue...",
    "[PRIORITY: Medium] Thirteenth issue...",
    "[PRIORITY: Medium] Fourteenth issue...",
    "[PRIORITY: Medium] Fifteenth issue...",
    "[PRIORITY: Medium] Sixteenth issue...",
    "[PRIORITY: Low] Seventeenth issue...",
    "[PRIORITY: Low] Eighteenth issue...",
    "[PRIORITY: Low] Nineteenth issue...",
    "[PRIORITY: Low] Twentieth issue...",
    "[PRIORITY: Low] Twenty-first issue...",
    "[PRIORITY: Low] Twenty-second issue...",
    "[PRIORITY: Low] Twenty-third issue...",
    "[PRIORITY: Low] Twenty-fourth issue...",
    "[PRIORITY: Low] Twenty-fifth issue..."
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

  // Technical factors
  if (contentData.metaDescription) score += 5;
  if (contentData.hasSchema) score += 8;

  // Image optimization
  if (contentData.images > 0) {
    const altCoverage = contentData.imagesWithAlt / contentData.images;
    score += altCoverage * 10;
  }

  // Internal linking
  if (contentData.internalLinks > 10) score += 5;

  // AI analysis impact
  const issues = aiAnalysis.needsAttention?.length || 0;
  score -= Math.min(issues * 0.8, 20); // Penalty for issues found

  return Math.max(20, Math.min(100, Math.round(score)));
}

/* ---------- HELPER FUNCTIONS ---------- */
function extractJSONObject(text) {
  // Remove markdown code blocks if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  // Find JSON object
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
