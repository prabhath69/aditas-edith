// Lead Intelligence Module — Google Dork templates, search query generation,
// and structured lead extraction for EDITH's lead-gathering capabilities.

import type { StoredSettings, Message } from './storage';
import { callLLM } from './llm';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LeadData {
    businessName: string;
    platform: string;       // e.g. "Instagram", "Facebook", "Google Maps"
    profileUrl: string;
    category: string;       // e.g. "Jewelry Store", "Clothing Boutique"
    location: string;
    contactInfo: string;    // phone, email, or "N/A"
    hasWebsite: boolean;
    websiteUrl: string;     // URL or "none"
    notes: string;          // bio excerpt, followers, etc.
}

export interface SearchQuery {
    query: string;
    platform: string;
    rationale: string;
}

export interface LeadGenPlan {
    isLeadGen: boolean;
    searchQueries: SearchQuery[];
    targetPlatforms: string[];
    extractionFields: string[];
    sheetAction: 'new_tab' | 'existing_tab' | 'none';
    reasoning: string;
}

// ─── Google Dork Templates ──────────────────────────────────────────────────

export const GOOGLE_DORK_TEMPLATES: Record<string, string[]> = {
    instagram: [
        'site:instagram.com "{industry}" "{location}" "shop" OR "store" OR "boutique" OR "order"',
        'site:instagram.com "{industry}" "{location}" "DM to order" OR "link in bio" OR "shop now"',
        'site:instagram.com "{industry}" "{location}" "handmade" OR "custom" OR "small business"',
        'site:instagram.com "{industry}" "{location}" -"website" -"www."',
    ],
    facebook: [
        'site:facebook.com "{industry}" "{location}" "shop" OR "store" OR "local business"',
        'site:facebook.com/pages "{industry}" "{location}"',
        'site:facebook.com "{industry}" "{location}" "message us" OR "DM for price"',
    ],
    google_maps: [
        'site:google.com/maps "{industry}" "{location}"',
        '"{industry}" "{location}" "no website" OR "not available" site:google.com/maps',
    ],
    linkedin: [
        'site:linkedin.com/company "{industry}" "{location}"',
        'site:linkedin.com/in "{industry}" "{location}" "founder" OR "owner"',
    ],
    directories: [
        '"{industry}" "{location}" "no website" OR "website: N/A" OR "website not available"',
        '"{industry}" "{location}" directory listing -site:amazon.com -site:ebay.com',
        '"{industry}" near "{location}" "contact" "phone" -site:yelp.com',
    ],
    general: [
        '"{industry}" "{location}" "instagram.com" -site:instagram.com',
        '"{industry}" "{location}" small business "no website"',
        '"{industry}" "{location}" "order via" OR "DM" OR "WhatsApp" -site:amazon.com',
    ],
};

// ─── Lead Gen Task Detection ────────────────────────────────────────────────

const LEAD_GEN_KEYWORDS = [
    'find leads', 'gather leads', 'lead generation', 'lead gen',
    'find businesses', 'find stores', 'find shops', 'find companies',
    'no website', 'without website', 'without a website',
    'add to sheet', 'add to spreadsheet', 'add to google sheet',
    'add to excel', 'leads sheet', 'leads spreadsheet',
    'find contacts', 'gather contacts', 'contact list',
    'prospecting', 'prospect list',
    'e-commerce stores', 'ecommerce stores', 'online stores',
    'local businesses', 'small businesses',
    'find on instagram', 'find on facebook', 'find on linkedin',
    'site:instagram', 'site:facebook',
];

/**
 * Detect if a user prompt is a lead-generation task.
 * Returns true if the prompt matches lead-gen patterns.
 */
export function isLeadGenTask(prompt: string): boolean {
    const lower = prompt.toLowerCase();

    // Check for explicit lead gen keyword combinations
    const hasLeadKeyword = LEAD_GEN_KEYWORDS.some(kw => lower.includes(kw));
    if (hasLeadKeyword) return true;

    // Check for compound intent: "find" + business type + location/platform
    const hasFindVerb = /\b(find|search|look for|gather|get|collect|scrape|hunt)\b/i.test(lower);
    const hasBusinessType = /\b(stores?|shops?|businesses?|companies|vendors?|sellers?|brands?|boutiques?|agencies)\b/i.test(lower);
    const hasPlatform = /\b(instagram|facebook|google maps|linkedin|yelp|yellow pages)\b/i.test(lower);
    const hasSheetAction = /\b(sheet|spreadsheet|excel|csv|google sheets|add.*data|enter.*data)\b/i.test(lower);

    // find + business type + (platform OR sheet action) = lead gen
    if (hasFindVerb && hasBusinessType && (hasPlatform || hasSheetAction)) return true;

    return false;
}

// ─── Search Query Generation ────────────────────────────────────────────────

const QUERY_GEN_PROMPT = `You are a lead generation expert. Given a user's request, generate precise Google search queries using advanced search operators (Google Dorks) to find the exact type of leads they need.

CRITICAL RULES:
1. Use site: operator to search specific platforms (site:instagram.com, site:facebook.com, etc.)
2. Use quoted phrases "like this" for exact matches
3. Use OR to combine alternatives
4. Use - to exclude irrelevant results
5. Generate 4-6 diverse queries targeting different platforms and angles
6. If the user wants businesses WITHOUT websites, include terms like "DM to order", "link in bio", "message us", "WhatsApp" which indicate no proper website
7. Be SPECIFIC — include the industry, location, and business type mentioned by the user

EXAMPLES:
- User: "Find e-commerce stores in Sydney with no websites"
  Queries:
  1. site:instagram.com "sydney" "shop" OR "store" "DM to order" OR "link in bio"
  2. site:instagram.com "sydney" "handmade" OR "boutique" "order" -"www."
  3. site:facebook.com "sydney" "shop" OR "store" "message us to order"
  4. "sydney" "small business" "instagram only" OR "no website" "shop"
  5. site:instagram.com "sydney" "e-commerce" OR "ecommerce" "shop now"

- User: "Find restaurants in Mumbai without a website"
  Queries:
  1. site:instagram.com "mumbai" "restaurant" OR "cafe" OR "food" "order" OR "delivery"
  2. site:google.com/maps "restaurant" "mumbai" -website
  3. "mumbai" "restaurant" "no website" "phone" OR "call" OR "WhatsApp"
  4. site:facebook.com "mumbai" "restaurant" OR "cafe" "message" OR "order"
  5. site:zomato.com "mumbai" restaurant "no website"

Respond in JSON format ONLY:
{
  "searchQueries": [
    {
      "query": "the exact Google search query",
      "platform": "which platform this targets",
      "rationale": "why this query will find good leads"
    }
  ],
  "targetPlatforms": ["instagram", "facebook", etc.],
  "extractionFields": ["businessName", "profileUrl", "category", "location", ...],
  "sheetAction": "existing_tab" or "none",
  "reasoning": "brief explanation of the search strategy"
}`;

/**
 * Use LLM to generate targeted Google Dork queries for lead generation.
 */
export async function generateSearchQueries(
    settings: StoredSettings,
    prompt: string,
): Promise<LeadGenPlan> {
    const messages: Message[] = [
        {
            id: 'leadgen-user',
            role: 'user',
            content: `Generate Google search queries to find leads for this task:\n\n"${prompt}"\n\nRemember to use site: operators, quoted phrases, OR operators, and exclusions. Be very specific and targeted.`,
            timestamp: Date.now(),
        },
    ];

    const response = await callLLM(settings, QUERY_GEN_PROMPT, messages, []);

    try {
        let jsonStr = response.content.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();

        const plan = JSON.parse(jsonStr) as Omit<LeadGenPlan, 'isLeadGen'>;

        return {
            isLeadGen: true,
            ...plan,
            searchQueries: plan.searchQueries?.slice(0, 6) || [],
        };
    } catch {
        // Fallback: extract queries from text
        return {
            isLeadGen: true,
            searchQueries: extractQueriesFromText(prompt),
            targetPlatforms: ['instagram', 'google'],
            extractionFields: ['businessName', 'profileUrl', 'category', 'location', 'contactInfo'],
            sheetAction: prompt.toLowerCase().includes('sheet') ? 'existing_tab' : 'none',
            reasoning: 'Fallback — used template-based query generation',
        };
    }
}

/**
 * Fallback: Generate queries from templates when LLM parsing fails.
 */
function extractQueriesFromText(prompt: string): SearchQuery[] {
    const lower = prompt.toLowerCase();

    // Attempt to extract industry and location from the prompt
    const industryMatch = lower.match(/(?:find|search|look for|gather)\s+(?:leads?\s+(?:of|for)\s+)?(.+?)(?:\s+(?:in|from|near|at|around)\s+)/i);
    const locationMatch = lower.match(/(?:in|from|near|at|around)\s+([a-zA-Z\s]+?)(?:\s+(?:with|without|who|that|and|on|$))/i);

    const industry = industryMatch?.[1]?.trim() || 'stores';
    const location = locationMatch?.[1]?.trim() || '';

    const queries: SearchQuery[] = [];

    // Generate from Instagram templates
    if (location) {
        queries.push({
            query: `site:instagram.com "${industry}" "${location}" "shop" OR "store" OR "order"`,
            platform: 'instagram',
            rationale: `Search Instagram for ${industry} in ${location}`,
        });
        queries.push({
            query: `site:instagram.com "${industry}" "${location}" "DM to order" OR "link in bio"`,
            platform: 'instagram',
            rationale: `Find Instagram-only businesses (no website) in ${location}`,
        });
        queries.push({
            query: `site:facebook.com "${industry}" "${location}" "shop" OR "business"`,
            platform: 'facebook',
            rationale: `Search Facebook for ${industry} in ${location}`,
        });
        queries.push({
            query: `"${industry}" "${location}" "no website" OR "instagram only" OR "contact us"`,
            platform: 'general',
            rationale: `General search for businesses without websites`,
        });
    } else {
        queries.push({
            query: `site:instagram.com "${industry}" "shop" OR "store" "DM to order"`,
            platform: 'instagram',
            rationale: `Search Instagram for ${industry}`,
        });
        queries.push({
            query: `site:facebook.com "${industry}" "shop" OR "small business"`,
            platform: 'facebook',
            rationale: `Search Facebook for ${industry}`,
        });
    }

    return queries;
}

// ─── Lead Extraction Prompt ─────────────────────────────────────────────────

/**
 * Build a focused extraction prompt for the sub-task agent based on
 * what platform/page it's looking at.
 */
export function buildExtractionPrompt(platform: string, _fields: string[]): string {
    return `You are extracting lead/business data from ${platform} search results.

FOR EACH business/profile you find on the page, extract:
- Business name
- Profile/page URL (full URL)
- Category/industry (what they sell or do)
- Location (city, state, country if visible)
- Contact info (phone, email, WhatsApp — or "N/A")
- Has website? (yes/no — look for link in bio, website field, or external URL)
- Website URL (if they have one, otherwise "none")
- Notes (follower count, bio excerpt, any relevant detail)

IMPORTANT:
- Extract ALL businesses visible on the page, not just one
- Scroll down to find more results if needed
- Format as a clean list, one business per block
- If a result is not a business (e.g. news article, personal account), SKIP it
- Look at the page text AND element labels to find business information

When you have extracted all visible leads, call extract_data() with ALL the data formatted clearly.`;
}

// ─── Google Sheets Entry Prompt ─────────────────────────────────────────────

/**
 * Build a prompt for entering leads into Google Sheets.
 */
export function buildSheetEntryPrompt(leads: string, columnHeaders?: string[]): string {
    const headers = columnHeaders?.join(', ') || 'Business Name, Platform, URL, Category, Location, Contact, Has Website, Website URL, Notes';

    return `You need to enter the following lead data into a Google Sheet that is already open in the browser.

LEAD DATA TO ENTER:
${leads}

COLUMN HEADERS (in order): ${headers}

GOOGLE SHEETS DATA ENTRY WORKFLOW:
1. First, take_snapshot() to see the current state of the Google Sheet.
2. Find the first EMPTY row. Look at the row numbers and find where data ends.
3. Click on the first empty cell in column A of that row.
4. Type the first value (business name), then press Tab to move to the next column.
5. Type the next value, press Tab again. Repeat for all columns.
6. After the last column, press Enter to move to the next row.
7. Repeat steps 4-6 for each lead.
8. After entering ALL leads, call task_complete().

CRITICAL RULES:
- Click on a CELL first before typing into it.
- Use Tab to move between columns within a row.
- Use Enter to move to the start of the next row.
- If a value contains commas, just type it normally (Sheets handles it).
- Enter "N/A" for missing data, never leave a cell empty.
- NEVER stop after entering just one lead. Enter ALL leads.
- If the sheet already has headers, start entering data in the row below the headers.
- If the sheet is blank, first enter the column headers, then the data.`;
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Parse extracted lead text into structured LeadData objects.
 * Used internally to organize data before sheet entry.
 */
export function parseExtractedLeads(rawText: string): LeadData[] {
    const leads: LeadData[] = [];
    // Split by common delimiters between lead entries
    const blocks = rawText.split(/(?:\n\n|\n---\n|\n-{3,}\n|\d+\.\s+)/);

    for (const block of blocks) {
        if (block.trim().length < 10) continue;

        const lead: LeadData = {
            businessName: extractField(block, ['business name', 'name', 'store', 'shop']),
            platform: extractField(block, ['platform', 'source', 'found on']),
            profileUrl: extractField(block, ['url', 'profile url', 'link', 'profile']),
            category: extractField(block, ['category', 'industry', 'type', 'what they sell']),
            location: extractField(block, ['location', 'city', 'address', 'based in']),
            contactInfo: extractField(block, ['contact', 'phone', 'email', 'whatsapp']),
            hasWebsite: !/(no website|none|n\/a|no|website: none)/i.test(
                extractField(block, ['has website', 'website'])
            ),
            websiteUrl: extractField(block, ['website url', 'website', 'site']),
            notes: extractField(block, ['notes', 'bio', 'description', 'followers']),
        };

        // Only include if we got at least a name
        if (lead.businessName && lead.businessName !== 'N/A') {
            leads.push(lead);
        }
    }

    return leads;
}

function extractField(text: string, fieldNames: string[]): string {
    for (const name of fieldNames) {
        const regex = new RegExp(`${name}\\s*[:=\\-–]\\s*(.+?)(?:\\n|$)`, 'i');
        const match = text.match(regex);
        if (match) return match[1].trim();
    }
    return 'N/A';
}
