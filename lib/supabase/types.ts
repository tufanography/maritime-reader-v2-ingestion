// Hand-written DB types matching supabase/migrations/001_initial.sql.
// (For a real project, generate with `supabase gen types typescript`.)

export type Category = {
  id: string;
  name: string;
  slug: string;
  color: string;
  order_index: number;
  created_at: string;
};

export type SourceType = 'rss' | 'html' | 'press_release';

export type Source = {
  id: string;
  name: string;
  website_url: string;
  type: SourceType;
  feed_url: string | null;
  scraper_config: Record<string, unknown>;
  category_hint: string | null;
  enabled: boolean;
  scrape_interval_minutes: number;
  request_delay_ms: number;
  last_scraped_at: string | null;
  last_status: string | null;
  last_error: string | null;
  /** Round-robin pointer for scraper_config.job_groups. Modulo the live
   *  group count at read time so changing group counts is safe. */
  last_group_index: number;
  /** trusted: P&I/MOU/class/regulator — direct publish at content_quality='visible'.
   *  aggregator: WordPress feeds with off-topic noise — content_quality='pending'
   *  on insert; the AI tagger updates them once classified. */
  trust_level: 'trusted' | 'aggregator';
  created_at: string;
  updated_at: string;
};

export type Article = {
  id: string;
  source_id: string;
  category_id: string | null;
  title: string;
  url: string;
  url_hash: string;
  author: string | null;
  published_at: string | null;
  /** Provenance of published_at. See migration 037 for strict definitions.
   *  NOT NULL — defaults to 'unknown' for legacy rows. */
  published_at_source: 'original' | 'scraper_default' | 'ai_corrected' | 'unknown';
  /** Trust level for published_at. NULL = not yet assessed; consumers treat
   *  NULL or non-'high' as approximate (show the "~" prefix on the date). */
  published_at_confidence: 'high' | 'medium' | 'low' | null;
  raw_excerpt: string | null;
  summary: string | null;
  ai_categorized: boolean;
  ai_confidence: number | null;
  image_url: string | null;
  click_count: number;
  view_count: number;
  /** V3: derived from source category_hint + article category + content. */
  document_type:
    | 'news'
    | 'press_release'
    | 'pi_circular'
    | 'class_notice'
    | 'regulation'
    | 'market_report'
    | 'casualty_report'
    | null;
  /** V3: vessel segments — tanker, dry_bulk, container, lng_lpg, offshore, cruise. */
  segments: string[];
  /** Risk/impact-based classification — see lib/v3/themes.ts. Multi-label,
   *  0-3 entries typical. Set by AI tagging. */
  semantic_themes: string[];
  /** Visibility state. Drives whether the article shows in public
   *  views. NULL = legacy rule-based (still visible). visible +
   *  pending = shown. hidden = filtered out. */
  content_quality: 'visible' | 'hidden' | 'pending' | null;
  /** V3: editorial pin for the home page Featured Story. */
  is_featured: boolean;
  featured_until: string | null;
  is_breaking: boolean;
  created_at: string;
};

export type Profile = {
  user_id: string;
  display_name: string;
  bio: string | null;
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: string;
  article_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};

export type ReactionKind = 'like' | 'dislike';

export type CommentWithMeta = Comment & {
  profile: Pick<Profile, 'user_id' | 'display_name'> | null;
  like_count: number;
  dislike_count: number;
  my_reaction: ReactionKind | null;
  replies?: CommentWithMeta[];
};

export type FeedbackType = 'suggestion' | 'bug' | 'complaint' | 'other';
export type FeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix';

export type Feedback = {
  id: string;
  user_id: string | null;
  email: string | null;
  type: FeedbackType;
  body: string;
  status: FeedbackStatus;
  admin_notes: string | null;
  reply_body: string | null;
  replied_at: string | null;
  created_at: string;
};

export type SubscriptionFrequency = 'daily' | 'weekly';

export type UserSubscription = {
  user_id: string;
  enabled: boolean;
  frequency: SubscriptionFrequency;
  send_hour_utc: number;
  category_slugs: string[];
  source_ids: string[];
  keywords: string[];
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SentDigest = {
  id: string;
  user_id: string;
  article_ids: string[];
  subject: string;
  sent_at: string;
  provider_id: string | null;
  delivered: boolean;
};

export type ArticleWithJoins = Article & {
  source: Pick<Source, 'id' | 'name' | 'website_url'> | null;
  category: Pick<Category, 'id' | 'name' | 'slug' | 'color'> | null;
};

export type ScrapeLog = {
  id: string;
  source_id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'error' | 'blocked' | 'partial';
  articles_found: number;
  articles_new: number;
  error_message: string | null;
  http_status: number | null;
};
