const DEFAULT_MODEL_LABEL_PATTERN = '^llm-(.+)$';

export function extractModelLabelToken(
    labels: Array<{ name: string } | string> | null | undefined,
    pattern = process.env.MODEL_LABEL_PATTERN || DEFAULT_MODEL_LABEL_PATTERN
): string | null {
    if (!labels || !Array.isArray(labels)) return null;

    const modelLabelRegex = new RegExp(pattern);
    for (const label of labels) {
        const labelName = typeof label === 'string' ? label : label.name;
        const match = labelName.match(modelLabelRegex);
        if (match) return match[1];
    }

    return null;
}
