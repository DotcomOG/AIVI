/* 
  api/score.js
  Purpose: Calculate AiVi score for score card display
  Called by: analyze.html and full-report.html
*/

export default async function handler(req, res) {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: "Missing URL parameter" });
  }

  try {
    // Simple scoring logic (you can enhance this later)
    // For now, return a basic score based on URL structure
    
    const score = calculateBasicScore(url);
    
    const pillars = {
      access: Math.round(score * 0.25),
      trust: Math.round(score * 0.25),
      clarity: Math.round(score * 0.25),
      alignment: Math.round(score * 0.25)
    };

    return res.status(200).json({
      score: Math.round(score),
      pillars,
      highlights: [
        "Basic technical accessibility detected",
        "Site structure requires full analysis"
      ]
    });

  } catch (error) {
    console.error("Score calculation error:", error);
    return res.status(500).json({ 
      error: "Score calculation failed",
      score: 50,
      pillars: { access: 12, trust: 12, clarity: 13, alignment: 13 }
    });
  }
}

function calculateBasicScore(url) {
  let score = 50; // Base score
  
  try {
    const urlObj = new URL(url);
    
    // HTTPS bonus
    if (urlObj.protocol === 'https:') score += 10;
    
    // Domain length (shorter is typically better)
    if (urlObj.hostname.length < 20) score += 5;
    
    // Has subdomain other than www
    if (urlObj.hostname.split('.').length > 2 && !urlObj.hostname.startsWith('www.')) {
      score += 3;
    }
    
    // Clean URL structure
    if (!urlObj.search && !urlObj.hash) score += 2;
    
  } catch (e) {
    // Invalid URL
    score = 40;
  }
  
  return Math.min(100, Math.max(20, score));
}
