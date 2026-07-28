// components/MarkdownContent.tsx
// This codebase's first markdown-rendering feature (settled July 28, 2026,
// Event.description) -- NewsPost.content deliberately stayed plain text
// ("no markdown rendering exists anywhere else in this codebase yet", see
// models/NewsPost.ts), so this is a fresh, reusable presentational wrapper
// rather than something duplicated per call site.
//
// Safe by default, not by sanitizing the stored string: react-markdown
// parses markdown into a syntax tree and renders it directly as React
// elements (never via dangerouslySetInnerHTML) -- raw HTML embedded in the
// source is treated as literal text, not interpreted, since no rehype-raw
// plugin is wired in here. That's what actually prevents XSS from
// user-supplied markdown, not any escaping done at write time.
//
// remark-gfm adds GitHub-flavored extras (autolinked bare URLs,
// strikethrough, tables). remark-breaks turns a single newline into a real
// line break -- plain CommonMark requires a blank line (or two trailing
// spaces) for that, which would be a confusing surprise for a TO typing
// into a plain <textarea> and expecting Enter to just work.
//
// No "use client" -- react-markdown renders to plain React elements with no
// browser-only hooks, so this works fine as a Server Component too (see
// app/events/[id]/page.tsx, itself a Server Component).
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="text-[13px] text-[var(--text-secondary)] leading-relaxed [&_a]:text-[var(--blue)] [&_a:hover]:underline [&_strong]:text-[var(--text-primary)] [&_h1]:font-rajdhani [&_h1]:font-bold [&_h1]:text-[var(--text-primary)] [&_h2]:font-rajdhani [&_h2]:font-bold [&_h2]:text-[var(--text-primary)] [&_h3]:font-rajdhani [&_h3]:font-bold [&_h3]:text-[var(--text-primary)] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:border-[var(--border-strong)] [&_code]:bg-[var(--navy-3)] [&_code]:px-1 [&_code]:rounded [&_code]:text-[12px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
