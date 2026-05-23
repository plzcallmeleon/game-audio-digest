#!/usr/bin/env node

// ============================================================================
// Game Audio Digest — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-podcasts.json, feed-blogs.json, and feed-reddit.json.
//
// Deduplication: tracks previously seen tweet IDs, episode GUIDs, article
// URLs, and Reddit post fullnames in state-feed.json so content is never
// repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --podcasts-only | --blogs-only | --reddit-only]
// Env vars needed: X_BEARER_TOKEN (optional), POD2TXT_API_KEY
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const POD2TXT_BASE = 'https://pod2txt.vercel.app/api';
const X_API_BASE = 'https://api.x.com/2';
// Some RSS hosts (notably Substack) block non-browser user agents from cloud IPs.
// Using a real Chrome UA avoids 403 errors in GitHub Actions.
const RSS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly, not daily
const BLOG_LOOKBACK_HOURS = 72;
const REDDIT_LOOKBACK_HOURS = 48;  // 2 days — Reddit hot posts change frequently
const MAX_TWEETS_PER_USER = 3;
const MAX_ARTICLES_PER_BLOG = 3;
const MAX_REDDIT_POSTS = 10;       // max posts total across all subreddits

// Reddit API requires a descriptive User-Agent per https://www.reddit.com/wiki/api
const REDDIT_USER_AGENT = 'GameAudioDigest/1.0 (feed aggregator; contact via GitHub)';

// State file lives in the repo root so it gets committed by GitHub Actions
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

// Tracks which tweet IDs and video IDs we've already included in feeds
// so we never send the same content twice across runs.

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {}, seenRedditPosts: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    // Ensure all fields exist for older state files
    if (!state.seenArticles) state.seenArticles = {};
    if (!state.seenRedditPosts) state.seenRedditPosts = {};
    return state;
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {}, seenRedditPosts: {} };
  }
}

async function saveState(state) {
  // Prune entries older than 7 days to prevent the file from growing forever
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  for (const [id, ts] of Object.entries(state.seenArticles || {})) {
    if (ts < cutoff) delete state.seenArticles[id];
  }
  for (const [id, ts] of Object.entries(state.seenRedditPosts || {})) {
    if (ts < cutoff) delete state.seenRedditPosts[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Podcast Fetching (RSS show notes, no transcript API required) ----------

// Parses an RSS feed XML string and returns episode objects with
// title, publishedAt, guid, link, and description (show notes).
function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
      || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    const guidMatch = block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/)
      || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;

    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;

    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    // Extract show notes: prefer <itunes:summary> or <description> (strip HTML tags)
    const itunesSummaryMatch = block.match(/<itunes:summary><!\[CDATA\[([\s\S]*?)\]\]><\/itunes:summary>/)
      || block.match(/<itunes:summary>([\s\S]*?)<\/itunes:summary>/);
    const descriptionMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)
      || block.match(/<description>([\s\S]*?)<\/description>/);
    const rawDescription = (itunesSummaryMatch || descriptionMatch)?.[1] || '';
    // Strip HTML tags and decode common entities, truncate to 2000 chars
    const description = rawDescription
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 2000);

    if (guid) {
      episodes.push({ title, guid, publishedAt, link, description });
    }
  }
  return episodes;
}

// Fetches a transcript from pod2txt. The API is async: first request may
// return "processing", so we poll until "ready" (up to 5 attempts, ~2.5 min).
async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 5;
  const pollInterval = 30000; // 30 seconds between polls

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();

    if (data.status === 'ready' && data.url) {
      // Transcript is ready — fetch the text from the provided URL
      const txtRes = await fetch(data.url);
      if (!txtRes.ok) return { error: `Failed to fetch transcript text: HTTP ${txtRes.status}` };
      const transcript = await txtRes.text();
      return { transcript };
    }

    if (data.status === 'processing') {
      console.error(`      pod2txt: processing (attempt ${attempt}/${maxAttempts}), waiting ${pollInterval / 1000}s...`);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, pollInterval));
      }
      continue;
    }

    // Unexpected status or error from the API
    return { error: data.message || `Unexpected status: ${data.status}` };
  }

  return { error: 'Timed out waiting for transcript processing' };
}

// Main podcast fetching function.
// Uses RSS show notes (description/itunes:summary) instead of transcripts.
// No external API required.
async function fetchPodcastContent(podcasts, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const results = [];

  for (const podcast of podcasts) {
    if (!podcast.rssUrl) {
      errors.push(`Podcast: No rssUrl configured for ${podcast.name}`);
      continue;
    }

    try {
      console.error(`  Fetching RSS for ${podcast.name}...`);
      const rssRes = await fetch(podcast.rssUrl, {
        headers: {
          'User-Agent': RSS_USER_AGENT,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        },
        signal: AbortSignal.timeout(30000)
      });

      if (!rssRes.ok) {
        errors.push(`Podcast: Failed to fetch RSS for ${podcast.name}: HTTP ${rssRes.status}`);
        continue;
      }

      const rssXml = await rssRes.text();
      const episodes = parseRssFeed(rssXml);
      console.error(`  ${podcast.name}: found ${episodes.length} episodes`);

      // Find the most recent unseen episode within the lookback window
      for (const episode of episodes.slice(0, 5)) {
        if (state.seenVideos[episode.guid]) continue;
        if (episode.publishedAt && new Date(episode.publishedAt) < cutoff) continue;

        // Skip if no useful content
        if (!episode.description || episode.description.length < 50) {
          console.error(`    "${episode.title}": description too short, skipping`);
          state.seenVideos[episode.guid] = Date.now();
          continue;
        }

        console.error(`    Selected: "${episode.title}" (show notes: ${episode.description.length} chars)`);
        state.seenVideos[episode.guid] = Date.now();

        results.push({
          source: 'podcast',
          name: podcast.name,
          title: episode.title,
          guid: episode.guid,
          url: episode.link || podcast.url,
          publishedAt: episode.publishedAt,
          transcript: episode.description  // field name kept as 'transcript' for prompt compatibility
        });
        break; // one episode per podcast per run
      }
    } catch (err) {
      errors.push(`Podcast: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  console.error(`  Podcasts: ${results.length} episode(s) with show notes`);
  return results;
}

// -- X/Twitter Fetching (Official API v2) ------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup all user IDs (1 API call)
  const handles = xAccounts.map(a => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (max 3, exclude retweets/replies)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=5` +       // fetch 5, then filter to 3 new ones
        `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      // Filter out already-seen tweets, cap at 3
      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue; // dedup
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          // note_tweet.text has the full untruncated text for long tweets (>280 chars)
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null
        });

        // Mark as seen
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Reddit Fetching (JSON API preferred, RSS fallback) ---------------------

// Fetches hot posts from specified subreddits.
// Tries Reddit's JSON API first (needs OAuth, may 403).
// Falls back to RSS feeds (no auth required) on failure.
// Applies two filter layers:
//   1. upvote threshold (per-subreddit configurable)
//   2. keyword filter (for general subreddits like r/gamedev)

// Parses a Reddit RSS (Atom) feed and returns post-like objects.
// RSS doesn't include upvote/comment counts, so those default to 0.
function parseRedditRssFeed(xml, subreddit) {
  const posts = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : null;
    if (!title || title === '[deleted]' || title === '[removed]') continue;

    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/);
    const url = linkMatch ? linkMatch[1].trim() : null;
    if (!url) continue;

    const idMatch = block.match(/<id>([\s\S]*?)<\/id>/);
    const id = idMatch ? idMatch[1].trim() : url;

    const pubMatch = block.match(/<published>([^<]+)/) || block.match(/<updated>([^<]+)/);
    const publishedAt = pubMatch ? new Date(pubMatch[1].trim()).toISOString() : null;

    const contentMatch = block.match(/<content[^>]*type="html"[^>]*>([\s\S]*?)<\/content>/i)
      || block.match(/<summary[^>]*type="html"[^>]*>([\s\S]*?)<\/summary>/i);
    const rawContent = contentMatch ? contentMatch[1] : '';
    const selftext = rawContent
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 600);

    posts.push({
      id,
      title,
      url,
      publishedAt,
      selftext,
      ups: 0,
      numComments: 0
    });
  }
  return posts;
}

async function fetchRedditContent(redditSources, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - REDDIT_LOOKBACK_HOURS * 60 * 60 * 1000);
  let totalCollected = 0;

  for (const source of redditSources) {
    if (totalCollected >= MAX_REDDIT_POSTS) break;

    console.error(`  Fetching r/${source.subreddit}...`);
    let posts = [];

    // Strategy 1: Try JSON API
    try {
      const jsonUrl = source.url; // e.g. https://www.reddit.com/r/GameAudio/hot.json
      const res = await fetch(jsonUrl, {
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (res.ok) {
        const data = await res.json();
        const children = data?.data?.children || [];
        console.error(`  r/${source.subreddit}: ${children.length} posts (JSON API)`);
        for (const child of children) {
          const post = child.data;
          posts.push({
            id: `t3_${post.id}`,
            title: post.title,
            url: `https://www.reddit.com${post.permalink}`,
            publishedAt: new Date(post.created_utc * 1000).toISOString(),
            selftext: (post.selftext || '').slice(0, 600).trim(),
            ups: post.ups || 0,
            numComments: post.num_comments || 0
          });
        }
      } else {
        // JSON API failed — try RSS fallback
        console.error(`  JSON API returned ${res.status}, trying RSS fallback...`);
        const rssUrl = `https://www.reddit.com/r/${source.subreddit}/hot/.rss`;
        const rssRes = await fetch(rssUrl, {
          headers: { 'User-Agent': REDDIT_USER_AGENT, 'Accept': 'application/rss+xml, application/xml' },
          signal: AbortSignal.timeout(15000)
        });
        if (rssRes.ok) {
          const xml = await rssRes.text();
          posts = parseRedditRssFeed(xml, source.subreddit);
          console.error(`  r/${source.subreddit}: ${posts.length} posts (RSS fallback)`);
        } else {
          errors.push(`Reddit: Failed to fetch r/${source.subreddit}: HTTP ${res.status} (JSON), ${rssRes.status} (RSS)`);
          continue;
        }
      }
    } catch (err) {
      errors.push(`Reddit: Error fetching r/${source.subreddit}: ${err.message}`);
      continue;
    }

    // Process posts (dedup, filter, collect)
    for (const post of posts) {
      if (totalCollected >= MAX_REDDIT_POSTS) break;
      if (state.seenRedditPosts[post.id]) continue;

      const postDate = post.publishedAt ? new Date(post.publishedAt) : null;
      if (postDate && postDate < cutoff) continue;

      // Apply upvote filter (only if JSON API gave us upvotes)
      if (post.ups > 0 && post.ups < source.minUpvotes) continue;

      // Apply keyword filter
      if (source.keywords && source.keywords.length > 0) {
        const titleLower = post.title.toLowerCase();
        const bodyLower = post.selftext.toLowerCase();
        const hasKeyword = source.keywords.some(kw =>
          titleLower.includes(kw) || bodyLower.includes(kw)
        );
        if (!hasKeyword) continue;
      }

      results.push({
        source: 'reddit',
        subreddit: source.subreddit,
        fullname: post.id,
        title: post.title,
        url: post.url,
        upvotes: post.ups || 0,
        commentCount: post.numComments || 0,
        selftext: post.selftext,
        publishedAt: post.publishedAt
      });

      state.seenRedditPosts[post.id] = Date.now();
      totalCollected++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.error(`  Reddit: collected ${results.length} post(s) total`);
  return results;
}

// -- Blog RSS Fetching (for blogs with RSS feeds) -----------------------------

// Parses an RSS blog feed and returns articles with title, url, date, content.
// Tries <content:encoded> for full text, falls back to <description>.
async function fetchRssBlogContent(blog, state, errors) {
  if (!blog.rssUrl) return [];

  try {
    const res = await fetch(blog.rssUrl, {
      headers: {
        'User-Agent': RSS_USER_AGENT,
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      errors.push(`Blog RSS: Failed to fetch ${blog.name}: HTTP ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const articles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let itemMatch;
    const seenUrls = new Set();

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const block = itemMatch[1];

      const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
        || block.match(/<title>([\s\S]*?)<\/title>/);
      const title = titleMatch ? titleMatch[1].trim() : null;
      if (!title) continue;

      const linkMatch = block.match(/<link[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/link>/);
      let url = linkMatch ? (linkMatch[1] || linkMatch[2] || '').trim() : null;
      if (!url || url === '/') continue;

      // Resolve relative URLs
      if (url.startsWith('/') && blog.rssUrl) {
        try {
          const rssBase = new URL(blog.rssUrl);
          url = `${rssBase.protocol}//${rssBase.host}${url}`;
        } catch { continue; }
      }

      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;

      const contentMatch = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/i);
      const descMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i)
        || block.match(/<description>([\s\S]*?)<\/description>/i);
      const rawContent = (contentMatch || descMatch)?.[1] || '';
      const content = rawContent
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim()
        .slice(0, 3000);

      if (!content || content.length < 50) continue;

      articles.push({ title, url, publishedAt: publishedAt || null, content });
    }

    console.error(`    RSS: found ${articles.length} articles`);
    return articles;
  } catch (err) {
    errors.push(`Blog RSS: Error fetching ${blog.name}: ${err.message}`);
    return [];
  }
}

// -- Game Developer Audio HTML scraping --------------------------------------

// Extracts article links from the Game Developer Audio index page.
function parseGameDeveloperAudioIndex(html) {
  const articles = [];
  const seenUrls = new Set();
  const linkRegex = /href="(https?:\/\/www\.gamedeveloper\.com\/audio\/[a-z0-9-]+)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const url = linkMatch[1];
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    articles.push({ title: '', url, publishedAt: null, description: '' });
  }
  return articles;
}

// Extracts full content from a Game Developer Audio article page.
function extractGameDeveloperAudioContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'NewsArticle' || ld['@type'] === 'Article') {
        title = ld.headline || '';
        author = ld.author?.name || ld.author?.[0]?.name || '';
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {}
  }

  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, author, publishedAt, content };
}

// -- Generic Blog HTML Fallback ----------------------------------------------

// Extracts article links from any HTML page using common patterns.
function parseGenericBlogIndex(html, baseUrl) {
  const articles = [];
  const seenUrls = new Set();
  const linkRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    let url = linkMatch[1];
    const linkText = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    if (url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:')) continue;
    if (['/', ''].includes(url)) continue;
    if (linkText.length < 3) continue;
    if (url.startsWith('/') && baseUrl) {
      try {
        const base = new URL(baseUrl);
        url = `${base.protocol}//${base.host}${url}`;
      } catch { continue; }
    }
    if (!url.startsWith('http')) continue;
    if (seenUrls.has(url)) continue;
    const skipPatterns = ['/tag/', '/category/', '/author/', '/page/', '/feed', '/wp-'];
    if (skipPatterns.some(p => url.includes(p))) continue;
    seenUrls.add(url);
    articles.push({ title: linkText, url, publishedAt: null, description: '' });
  }
  return articles.slice(0, 15);
}

// Generic content extractor for any HTML article page.
function extractGenericBlogContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'BlogPosting' || ld['@type'] === 'NewsArticle' || ld['@type'] === 'Article') {
        if (!title) title = ld.headline || ld.name || '';
        if (!author) author = ld.author?.name || ld.author?.[0]?.name || '';
        if (!publishedAt) publishedAt = ld.datePublished || null;
        if (title) break;
      }
    } catch {}
  }

  if (!title) {
    const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (ogTitleMatch) title = ogTitleMatch[1];
  }
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, author, publishedAt, content };
}

// -- Blog Fetching (HTML scraping) -------------------------------------------

// Scrapes the Anthropic Engineering blog index page.
// The page is a Next.js app that embeds article data as JSON in <script> tags.
// We parse that JSON to extract article metadata (title, slug, date, summary).
// Falls back to regex-based HTML parsing if the JSON approach fails.
function parseAnthropicEngineeringIndex(html) {
  const articles = [];

  // Strategy 1: Look for article data in Next.js __NEXT_DATA__ script tag
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      // Navigate the Next.js page props to find article entries
      const pageProps = data?.props?.pageProps;
      const posts = pageProps?.posts || pageProps?.articles || pageProps?.entries || [];
      for (const post of posts) {
        const slug = post.slug?.current || post.slug || '';
        articles.push({
          title: post.title || 'Untitled',
          url: `https://www.anthropic.com/engineering/${slug}`,
          publishedAt: post.publishedOn || post.publishedAt || post.date || null,
          description: post.summary || post.description || ''
        });
      }
      if (articles.length > 0) return articles;
    } catch {
      // JSON parsing failed, fall through to regex approach
    }
  }

  // Strategy 2: Regex-based extraction from the rendered HTML.
  // Anthropic engineering articles follow the pattern /engineering/<slug>
  const linkRegex = /href="\/engineering\/([a-z0-9-]+)"/gi;
  const seenSlugs = new Set();
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://www.anthropic.com/engineering/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Scrapes the Claude Blog index page (claude.com/blog).
// This is a Webflow site. We extract article links, titles, and dates
// from the HTML structure.
function parseClaudeBlogIndex(html) {
  const articles = [];
  const seenSlugs = new Set();

  // Match blog post links — they follow the pattern /blog/<slug>
  // We capture surrounding context to extract titles and dates
  const linkRegex = /href="\/blog\/([a-z0-9-]+)"/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const slug = linkMatch[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    articles.push({
      title: '', // Will be filled when we fetch the article page
      url: `https://claude.com/blog/${slug}`,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Extracts the main text content from an Anthropic Engineering article page.
// Tries the embedded JSON first (Next.js SSR data), then falls back to
// stripping HTML tags from the article body.
function extractAnthropicArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try to get structured data from Next.js __NEXT_DATA__
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const pageProps = data?.props?.pageProps;
      const post = pageProps?.post || pageProps?.article || pageProps?.entry || pageProps;
      title = post?.title || '';
      author = post?.author?.name || post?.authors?.[0]?.name || '';
      publishedAt = post?.publishedOn || post?.publishedAt || post?.date || null;

      // Extract text from the body blocks (Sanity CMS portable text format)
      const body = post?.body || post?.content || [];
      if (Array.isArray(body)) {
        const textParts = [];
        for (const block of body) {
          if (block._type === 'block' && block.children) {
            const text = block.children.map(c => c.text || '').join('');
            if (text.trim()) textParts.push(text.trim());
          }
        }
        content = textParts.join('\n\n');
      }
      if (content) return { title, author, publishedAt, content };
    } catch {
      // Fall through to HTML stripping
    }
  }

  // Fallback: extract title from <h1> and body from <article> or main content
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();

  // Try to find the article body and strip HTML tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyHtml = articleMatch ? articleMatch[1] : html;

  // Strip script/style tags first, then all remaining HTML tags
  content = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, author, publishedAt, content };
}

// Extracts the main text content from a Claude Blog article page.
// Uses JSON-LD schema data if present, then falls back to the rich text body.
function extractClaudeBlogArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try JSON-LD structured data first (most reliable for metadata)
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'BlogPosting' || ld['@type'] === 'Article') {
        title = ld.headline || ld.name || '';
        author = ld.author?.name || '';
        publishedAt = ld.datePublished || null;
        break;
      }
    } catch {
      // Not valid JSON-LD, skip
    }
  }

  // Extract body text from the Webflow rich text container
  const richTextMatch = html.match(/<div[^>]*class="[^"]*u-rich-text-blog[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (richTextMatch) {
    content = richTextMatch[1]
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // If rich text extraction failed, try a broader approach
  if (!content) {
    // Get title from <h1> if not already found
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }

    // Strip the whole page down to text as a last resort
    content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { title, author, publishedAt, content };
}

// Main blog fetching orchestrator.
// For each blog source, tries RSS first (if rssUrl is configured), then falls
// back to HTML scraping for sites with dedicated parsers or generic fallback.
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);
    let articlesFromBlog = 0;

    // ---- Strategy 1: RSS feed (most reliable) ----
    if (blog.rssUrl) {
      console.error(`    Trying RSS: ${blog.rssUrl}`);
      const rssArticles = await fetchRssBlogContent(blog, state, errors);
      for (const article of rssArticles) {
        if (state.seenArticles[article.url]) continue;
        if (article.publishedAt && new Date(article.publishedAt) < cutoff) continue;
        state.seenArticles[article.url] = Date.now();
        results.push({
          source: 'blog',
          name: blog.name,
          title: article.title,
          url: article.url,
          publishedAt: article.publishedAt || null,
          author: '',
          description: '',
          content: article.content
        });
        articlesFromBlog++;
        if (articlesFromBlog >= MAX_ARTICLES_PER_BLOG) break;
      }
      if (articlesFromBlog > 0) continue; // RSS worked
    }

    // ---- Strategy 2: HTML scraping ----
    console.error(`    Trying HTML scrape: ${blog.indexUrl}`);

    try {
      const indexRes = await fetch(blog.indexUrl, {
        headers: { 'User-Agent': RSS_USER_AGENT },
        signal: AbortSignal.timeout(15000)
      });
      if (!indexRes.ok) {
        errors.push(`Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`);
        continue;
      }
      const indexHtml = await indexRes.text();

      let candidates = [];
      if (blog.indexUrl.includes('gamedeveloper.com')) {
        candidates = parseGameDeveloperAudioIndex(indexHtml);
      } else if (blog.indexUrl.includes('anthropic.com')) {
        candidates = parseAnthropicEngineeringIndex(indexHtml);
      } else if (blog.indexUrl.includes('claude.com')) {
        candidates = parseClaudeBlogIndex(indexHtml);
      } else {
        candidates = parseGenericBlogIndex(indexHtml, blog.articleBaseUrl || blog.indexUrl);
      }

      const newArticles = [];
      for (const article of candidates.slice(0, MAX_ARTICLES_PER_BLOG)) {
        if (state.seenArticles[article.url]) continue;
        if (article.publishedAt && new Date(article.publishedAt) < cutoff) continue;
        newArticles.push(article);
        if (newArticles.length >= MAX_ARTICLES_PER_BLOG) break;
      }

      if (newArticles.length === 0) {
        console.error(`    No new articles found`);
        continue;
      }

      console.error(`    Found ${newArticles.length} new article(s), fetching content...`);

      for (const article of newArticles) {
        try {
          const articleRes = await fetch(article.url, {
            headers: { 'User-Agent': RSS_USER_AGENT },
            signal: AbortSignal.timeout(15000)
          });
          if (!articleRes.ok) {
            errors.push(`Blog: Failed to fetch article ${article.url}: HTTP ${articleRes.status}`);
            continue;
          }
          const articleHtml = await articleRes.text();

          let extracted;
          if (article.url.includes('gamedeveloper.com')) {
            extracted = extractGameDeveloperAudioContent(articleHtml);
          } else if (article.url.includes('anthropic.com/engineering')) {
            extracted = extractAnthropicArticleContent(articleHtml);
          } else if (article.url.includes('claude.com/blog')) {
            extracted = extractClaudeBlogArticleContent(articleHtml);
          } else {
            extracted = extractGenericBlogContent(articleHtml);
          }

          if (!extracted || !extracted.content) {
            errors.push(`Blog: No content extracted from ${article.url}`);
            continue;
          }

          results.push({
            source: 'blog',
            name: blog.name,
            title: extracted.title || article.title || 'Untitled',
            url: article.url,
            publishedAt: extracted.publishedAt || article.publishedAt || null,
            author: extracted.author || '',
            description: article.description || '',
            content: extracted.content
          });

          state.seenArticles[article.url] = Date.now();
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`Blog: Error fetching article ${article.url}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');
  const blogsOnly = args.includes('--blogs-only');
  const redditOnly = args.includes('--reddit-only');

  // If a specific --*-only flag is set, only that feed type runs.
  // If no flag is set, all four run.
  const onlyFlagSet = tweetsOnly || podcastsOnly || blogsOnly || redditOnly;
  const runTweets = tweetsOnly || !onlyFlagSet;
  const runPodcasts = podcastsOnly || !onlyFlagSet;
  const runBlogs = blogsOnly || !onlyFlagSet;
  const runReddit = redditOnly || !onlyFlagSet;

  const xBearerToken = process.env.X_BEARER_TOKEN;

  // X_BEARER_TOKEN is optional — if not set, tweets are skipped gracefully
  if (runTweets && !xBearerToken) {
    console.error('X_BEARER_TOKEN not set — skipping X/Twitter content');
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets (optional — requires X API key)
  if (runTweets && xBearerToken) {
    console.error('Fetching X/Twitter content...');
    const xContent = await fetchXContent(sources.x_accounts, xBearerToken, state, errors);
    console.error(`  Found ${xContent.length} builders with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xBuilders: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('X API')).length > 0
        ? errors.filter(e => e.startsWith('X API')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`);
  }

  // Fetch podcasts (uses RSS show notes, no API key required)
  if (runPodcasts) {
    console.error('Fetching podcast content (RSS show notes)...');
    const podcasts = await fetchPodcastContent(sources.podcasts, state, errors);
    console.error(`  Found ${podcasts.length} new episodes`);

    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors: errors.filter(e => e.startsWith('Podcast')).length > 0
        ? errors.filter(e => e.startsWith('Podcast')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

  // Fetch blog posts
  if (runBlogs && sources.blogs && sources.blogs.length > 0) {
    console.error('Fetching blog content...');
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: blogContent,
      stats: { blogPosts: blogContent.length },
      errors: errors.filter(e => e.startsWith('Blog')).length > 0
        ? errors.filter(e => e.startsWith('Blog')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-blogs.json'), JSON.stringify(blogFeed, null, 2));
    console.error(`  feed-blogs.json: ${blogContent.length} posts`);
  }

  // Fetch Reddit posts (free API, no key required)
  if (runReddit && sources.reddit && sources.reddit.length > 0) {
    console.error('Fetching Reddit content...');
    const redditContent = await fetchRedditContent(sources.reddit, state, errors);
    console.error(`  Found ${redditContent.length} Reddit post(s)`);

    const redditFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: REDDIT_LOOKBACK_HOURS,
      reddit: redditContent,
      stats: { redditPosts: redditContent.length },
      errors: errors.filter(e => e.startsWith('Reddit')).length > 0
        ? errors.filter(e => e.startsWith('Reddit')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-reddit.json'), JSON.stringify(redditFeed, null, 2));
    console.error(`  feed-reddit.json: ${redditContent.length} posts`);
  }

  // Save dedup state
  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
