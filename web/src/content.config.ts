import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro:schema'

/** Markdown docs; filenames provide the route ids. */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    /** Page title: the <h1>, the sidebar label, and the <title> label. */
    title: z.string(),
    /** Meta description, used for <meta>/OG. Keep it under ~160 chars. */
    description: z.string(),
    /** Sidebar sort key, low to high. Ties fall back to title order. */
    order: z.number().default(999),
    /** Renders the release-derived install controls below the title. */
    installMatrix: z.boolean().default(false)
  })
})

export const collections = { docs }
