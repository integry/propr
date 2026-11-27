/** Renders `backtick` spans in plain guidance text as inline code. */
export default function InlineCodeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`)/).map((part, index) => (
        part.length > 2 && part.startsWith('`') && part.endsWith('`')
          ? <code key={index} className="break-all rounded bg-black/5 px-1 font-mono">{part.slice(1, -1)}</code>
          : part
      ))}
    </>
  );
}
