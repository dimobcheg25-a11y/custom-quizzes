import { z } from 'zod';

/** Media file inside a pack folder. `file` is relative to the pack folder, e.g. "media/r1-movies-300.jpg". */
export const MediaSchema = z.object({
  kind: z.enum(['image', 'audio', 'video']),
  file: z
    .string()
    .min(1)
    .refine((f) => !f.includes('..') && !f.startsWith('/') && !/^[a-z]+:/i.test(f), 'file must be a relative path inside the pack'),
  /** Audio/video only: play from this second… */
  start: z.number().nonnegative().optional(),
  /** …and stop at this second (counts as the end of the media). */
  end: z.number().positive().optional(),
}).refine((m) => m.start === undefined || m.end === undefined || m.end > m.start, { message: 'end must be after start', path: ['end'] });

export const QuestionSchema = z
  .object({
    price: z.number().int().nonnegative().default(0),
    type: z.enum(['normal', 'cat', 'auction']).default('normal'),
    /** Question text shown to everyone. May be empty when the media says it all, but then `media` is required. */
    text: z.string().default(''),
    media: MediaSchema.optional(),
    /** Correct answer, shown to the host all the time and to players on reveal. */
    answer: z.string().min(1),
    answerMedia: MediaSchema.optional(),
    /** Shown to everyone on reveal: an interesting fact or explanation. */
    comment: z.string().optional(),
    /** Host only: accepted variants, how to judge borderline answers. */
    hostNote: z.string().optional(),
    /** "Кіт у мішку": theme announced when the question is passed. Defaults to the theme name. */
    catTheme: z.string().optional(),
    /** "Кіт у мішку": price of the cat. Defaults to `price`. */
    catPrice: z.number().int().positive().optional(),
  })
  .refine((q) => q.text.trim() !== '' || q.media, { message: 'question needs text or media' });

export const ThemeSchema = z.object({
  name: z.string().min(1),
  questions: z.array(QuestionSchema).min(1),
});

export const RoundSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['normal', 'final']).default('normal'),
    themes: z.array(ThemeSchema).min(1),
  })
  .superRefine((r, ctx) => {
    r.themes.forEach((t, ti) =>
      t.questions.forEach((q, qi) => {
        if (r.type === 'normal' && q.price <= 0)
          ctx.addIssue({ code: 'custom', path: ['themes', ti, 'questions', qi, 'price'], message: 'price must be > 0 in a normal round' });
        if (r.type === 'final' && q.type !== 'normal')
          ctx.addIssue({ code: 'custom', path: ['themes', ti, 'questions', qi, 'type'], message: 'final round questions must be normal' });
      }),
    );
    if (r.type === 'final') {
      r.themes.forEach((t, ti) => {
        if (t.questions.length !== 1)
          ctx.addIssue({ code: 'custom', path: ['themes', ti, 'questions'], message: 'final round themes must have exactly one question' });
      });
    }
  });

export const PackSchema = z.object({
  title: z.string().min(1),
  author: z.string().optional(),
  description: z.string().optional(),
  rounds: z.array(RoundSchema).min(1),
});

export type Media = z.infer<typeof MediaSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type Round = z.infer<typeof RoundSchema>;
export type Pack = z.infer<typeof PackSchema>;

export function packMediaFiles(pack: Pack): string[] {
  const files: string[] = [];
  for (const r of pack.rounds)
    for (const t of r.themes)
      for (const q of t.questions) {
        if (q.media) files.push(q.media.file);
        if (q.answerMedia) files.push(q.answerMedia.file);
      }
  return files;
}
