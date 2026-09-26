import type React from 'react';

export function clipboardImageFiles(event: React.ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData?.items || [])
    .filter(item => item.type.startsWith('image/'))
    .map((item, index) => {
      const blob = item.getAsFile();
      return blob ? new File([blob], `pasted-image-${Date.now()}-${index + 1}.png`, { type: blob.type || 'image/png' }) : null;
    })
    .filter((file): file is File => file !== null);
}
