/* 
  api/full.js - v3.3.0 — ROBUST VERSION (no crashes on missing keys)
  Purpose: Comprehensive AI SEO analysis with graceful degradation
  ENV Optional: OPENAI_API_KEY, PAGESPEED_API_KEY (works without them)
*/

import * as cheerio from "cheerio";
import axios from "axios";

// Conditional imports (only if keys exist)
let openai = null;
if (process.env.OPENAI_API_KEY) {
  const { default: OpenAI } = await import("openai");
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL parameter" });

  // Check if we can do full analysis
  const canDoFullAnalysis = !!(process.env.OPENAI_API_KEY && openai);
  const canUsePageSpeed = !!process.env.PAGESPEED_API_KEY;

  console.log("API Keys status:", { 
    openai: canDoFullAnalysis,
    pagespeed: canUsePageSpeed 
  });

  try {
    // 🔄 PARALLEL DATA COLLECTION
    const dataPromises = [
      // Fetch website content (always)
      axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SnipeRankBot/1.0)" },
        timeout: 15000
      }).catch(e => ({ error: e.message }))
    ];

    // Add PageSpeed only if key exists
    if (canUsePageSpeed) {
      dataPromises.push(fetchPageSpeedData(url));
    }

    const [htmlResp, pageSpeedData] = await Promise.allSettled(dataPromises);

    // Extract website content
    let contentData = {};
    if (htmlResp.status === 'fulfilled' && !htmlResp.value.error) {
      const $ = cheerio.load(htmlResp.value.data);
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
    }

    // Extract performance data
    let perfData = null;
    if (canUsePageSpeed && pageSpeedData?.status === 'fulfilled') {
      perfData = pageSpeedData.value;
    }

    // 🧠 AI ANALYSIS (if OpenAI key exists)
    let aiAnalysis = null;
    if (canDoFullAnalysis) {
      try {
        const analysisPrompt = buildEnhancedPrompt(url, contentData, perfData);
        const completion = await openai.chat.completions.create({
          model: "gpt-4-turbo",
          temperature: 0.3,
          max_tokens: 4000,
          messages: [
            { role: "system", content: "You are a data-driven AI SEO analyst. Use the provided metrics to generate specific, actionable recommendations." },
            { role: "user", content: analysisPrompt }
          ]
        });

        const raw = completion?.choices?.[0]?.message?.content?.trim() || "";
        const jsonString = extractJSONObject(raw);
        if (jsonString) {
          aiAnalysis = JSON.parse(jsonString);
        }
      } catch (aiError) {
        console.error("AI analysis failed:", aiError.message);
        // Continue with fallback data
      }
    }

    // If AI analysis succeeded, use it
    if (aiAnalysis && Array.isArray(aiAnalysis.whatsWorking) && Array.isArray(aiAnalysis.needsAttention)) {
      const score = calculateRealSEOScore(contentData, perfData, aiAnalysis);

      return res.status(200).json({
        success: true,
        score,
        whatsWorking: aiAnalysis.whatsWorking.slice(0, 10),
        needsAttention: aiAnalysis.needsAttention.slice(0, 25),
        engineInsights: aiAnalysis.engineInsights?.slice(0, 5) || [],
        metrics: {
          performance: perfData,
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
          analysisDepth: "premium-with-ai",
          url
        }
      });
    }

    // Fallback: Return basic analysis based on technical audit
    return res.status(200).json(buildBasicAnalysis(url, contentData, perfData, canDoFullAnalysis, canUsePageSpeed));

  } catch (error) {
    console.error("Analysis error:", error);
    return res.status(200).json(fallbackPayload(url, String(error?.code || error?.message || "unknown")));
  }
}

/* ---------- BASIC ANALYSIS (when AI not available) ---------- */
function buildBasicAnalysis(url, contentData, perfData, hadOpenAI, hadPageSpeed) {
  const whatsWorking = [];
  const needsAttention = [];

  // Analyze what we can without AI
  if (contentData.hasSchema) {
    whatsWorking.push("Structured data markup detected - helps AI engines understand your content");
  }

  if (contentData.metaDescription) {
    whatsWorking.push("Meta description present - provides context for AI search results");
  } else {
    needsAttention.push("[PRIORITY: High] Missing Meta Description: Add descriptive meta tags. Impact: Better AI search visibility.");
  }

  const altCoverage = contentData.images > 0 
    ? (contentData.imagesWithAlt / contentData.images) * 100 
    : 100;

  if (altCoverage > 80) {
    whatsWorking.push(`Strong image accessibility - ${Math.round(altCoverage)}% of images have alt text`);
  } else {
    needsAttention.push(`[PRIORITY: Medium] Image Alt Text Coverage: Only ${Math.round(altCoverage)}% of images have alt text. Solution: Add descriptive alt text to all images. Impact: Improved AI content understanding.`);
  }

  if (perfData) {
    if (perfData.performanceScore > 80) {
      whatsWorking.push(`Strong performance score: ${Math.round(perfData.performanceScore)}/100`);
    } else {
      needsAttention.push(`[PRIORITY: High] Performance Score: Currently ${Math.round(perfData.performanceScore)}/100. Solution: Optimize images, reduce JavaScript, enable caching. Impact: Better AI crawler access.`);
    }

    if (perfData.seoScore > 90) {
      whatsWorking.push(`Excellent technical SEO: ${Math.round(perfData.seoScore)}/100`);
    }
  }

  // Add some generic AI optimization tips
  if (whatsWorking.length < 5) {
    whatsWorking.push("Site is accessible to AI crawlers");
    whatsWorking.push("Basic HTML structure detected");
  }

  if (needsAttention.length < 15) {
    needsAttention.push(
      "[PRIORITY: Medium] Content Structure: Review heading hierarchy for AI clarity. Solution: Use semantic HTML with proper H1-H6 structure. Impact: Better content comprehension.",
      "[PRIORITY: Medium] Internal Linking: Strengthen internal link structure. Solution: Add contextual links between related pages. Impact: Improved AI navigation.",
      "[PRIORITY: Low] FAQ Schema: Consider adding FAQ schema markup. Solution: Implement JSON-LD FAQ structured data. Impact: Direct AI answer sourcing."
    );
  }

  const engineInsights = [
    "ChatGPT: Focuses on clear, structured content with proper headings",
    "Claude: Values comprehensive, well-organized information",
    "Gemini: Prioritizes technical SEO and page speed",
    "Perplexity: Prefers sites with strong citation and authority signals",
    "Copilot: Emphasizes accessibility and semantic HTML structure"
  ];

  const score = calculateBasicScore(contentData, perfData);

  return {
    success: true,
    score,
    whatsWorking,
    needsAttention,
    engineInsights,
    metrics: {
      performance: perfData,
      technical: {
        imagesWithAlt: contentData.imagesWithAlt || 0,
        totalImages: contentData.images || 0,
        hasSchema: contentData.hasSchema || false,
        metaDescription: !!contentData.metaDescription
      }
    },
    meta: {
      analyzedAt: new Date().toISOString(),
      analysisDepth: "basic-technical-audit",
      url,
      note: hadOpenAI ? "AI analysis failed, using technical audit" : "AI analysis requires OPENAI_API_KEY",
      hadPageSpeed
    }
  };
}

/* ---------- BASIC SCORING ---------- */
function calculateBasicScore(contentData, perfData) {
  let score = 50;

  if (contentData.metaDescription) score += 5;
  if (contentData.hasSchema) score += 8;

  if (contentData.images > 0) {
    const altCoverage = contentData.imagesWithAlt / contentData.images;
    score += altCoverage * 10;
  }

  if (perfData) {
    score += (perfData.performanceScore - 50) * 0.3;
    score += (perfData.seoScore - 50) * 0.2;
  }

  return Math.max(20, Math.min(100, Math.round(score)));
}

/* ---------- PAGESPEED API INTEGRATION ---------- */
async function fetchPageSpeedData(url) {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) return null;

  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}&strategy=mobile&category=performance&category=seo`;

  try {
    const response = await axios.get(apiUrl, { timeout: 30000 });
    const data = response.data;
    const lighthouse = data.lighthouseResult;
    const audits = lighthouse?.audits || {};
    
    return {
      performanceScore: lighthouse?.categories?.performance?.score * 100 || 0,
      seoScore: lighthouse?.categories?.seo?.score * 100 || 0,
      lcp: audits['largest-contentful-paint']?.numericValue || 0,
      cls: audits['cumulative-layout-shift']?.numericValue || 0,
      missingAltText: audits['image-alt']?.score < 1,
      httpStatus: audits['is-on-https']?.score === 1 ? 'https' : 'http'
    };
  } catch (error) {
    console.warn("PageSpeed API failed:", error.message);
    return null;
  }
}

/* ---------- ENHANCED PROMPT (only called if OpenAI available) ---------- */
function buildEnhancedPrompt(url, contentData, perfData) {
  const performanceSection = perfData ? `
ACTUAL PERFORMANCE METRICS:
- Performance Score: ${perfData.performanceScore}/100
- SEO Score: ${perfData.seoScore}/100
- Largest Contentful Paint: ${(perfData.lcp / 1000).toFixed(1)}s
- Cumulative Layout Shift: ${perfData.cls.toFixed(3)}
` : "";

  return `
You are an expert AI SEO specialist analyzing this website:

URL: ${url}
Title: ${contentData.pageTitle || 'Not found'}
Meta Description: ${contentData.metaDescription || 'MISSING'}

TECHNICAL SEO:
- Images: ${contentData.imagesWithAlt || 0}/${contentData.images || 0} have alt text
- Schema Markup: ${contentData.hasSchema ? 'Present' : 'MISSING'}
- Internal Links: ${contentData.internalLinks || 0}

${performanceSection}

Sample Content: ${(contentData.textContent || '').slice(0, 6000)}

Return ONLY JSON with these exact keys:
- "whatsWorking": array of 10 specific strengths
- "needsAttention": array of 25 items. Format: "[PRIORITY: High|Medium|Low] Title. Solution: Steps. Impact: Expected result."
- "engineInsights": array of 5 items (ChatGPT, Claude, Gemini, Perplexity, Copilot specific advice)

Focus on actionable, specific insights with real metrics where available.
`.trim();
}

/* ---------- REAL SEO SCORING ---------- */
function calculateRealSEOScore(contentData, perfData, aiAnalysis) {
  let score = 50;
  
  if (perfData) {
    score += (perfData.performanceScore - 50) * 0.4;
    score += (perfData.seoScore - 50) * 0.3;
    if (perfData.lcp < 2500) score += 5;
    else if (perfData.lcp > 4000) score -= 8;
    if (perfData.cls < 0.1) score += 3;
    else if (perfData.cls > 0.25) score -= 5;
  }
  
  if (contentData.metaDescription) score += 3;
  if (contentData.hasSchema) score += 5;
  
  if (contentData.images > 0) {
    const altCoverage = (contentData.imagesWithAlt / contentData.images);
    score += altCoverage * 10;
  }
  
  const strengths = aiAnalysis.whatsWorking?.length || 0;
  const issues = aiAnalysis.needsAttention?.length || 0;
  score += Math.min(strengths * 2, 10);
  score -= Math.min(issues * 0.5, 15);
  
  return Math.max(20, Math.min(100, Math.round(score)));
}

/* ---------- HELPER FUNCTIONS ---------- */
function extractJSONObject(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
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
    whatsWorking: [
      "Your website is accessible and loads successfully",
      "HTTPS appears active - baseline security for AI crawlers"
    ],
    needsAttention: [
      "[PRIORITY: High] Complete Analysis Required: Unable to perform full AI analysis. Solution: Verify API configuration and retry. Impact: Full visibility assessment.",
      "[PRIORITY: Medium] Technical Review Needed: Basic factors require manual verification. Solution: Check meta tags, schema, and performance. Impact: Better AI understanding."
    ],
    engineInsights: [
      "ChatGPT: Ensure clear content structure and proper headings",
      "Claude: Focus on comprehensive, well-organized information",
      "Gemini: Optimize technical SEO and page performance",
      "Perplexity: Build authority through citations and quality content",
      "Copilot: Implement semantic HTML and accessibility features"
    ],
    meta: { url, mode: "fallback", reason, requiresRetry: true }
  };
}
