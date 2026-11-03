const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** The MIME type of an image, by its extension; undefined for any other file. */
export function typeOf(path: string): string | undefined {
  return IMAGE_TYPES[path.toLowerCase().split('.').pop() ?? '']
}

/** A path's extension, lower-cased, or `png` when it has none. */
export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'png'
}

/** A file name for an answer or image: timestamp plus a slug of the prompt. */
export function fileName(prompt: string, now: Date, extension = 'md'): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const slug = prompt
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${stamp}-${slug || 'answer'}.${extension}`
}

/** Adds a variant number only when the request produced more than one image. */
export function variantPath(base: string, index: number, count: number): string {
  return count > 1 ? base.replace(/(\.\w+)?$/, `-${index + 1}$1`) : base
}
