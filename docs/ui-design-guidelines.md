This document establishes the **"Studio Aesthetic"** for the ProPR platform. It is designed to move the application away from generic web-form patterns toward a high-performance, high-density **Integrated Development Environment (IDE)** experience.

---

# ProPR Studio: Design & UI Guidelines

## 1. Core Philosophy
*   **The Workbench Metaphor:** The UI is a tool, not a document. Use full-screen width and height. Avoid "cards" floating on a page; use "panes" divided by lines.
*   **Success is Quiet:** Completed actions should recede into the background (Gray). Color is a limited resource reserved for **Action** (Teal), **Latency** (Blue), or **Caution** (Amber).
*   **Technical Authority:** Use monospace fonts for all data entities. Density is preferred over whitespace for engineering workflows.

---

## 2. Layout & App Shell
### A. The "Sandwich" Frame
*   **Anchored Header:** Always 100% width, fixed to the top. Use a subtle background (`bg-slate-50` or `gray-100`) and a crisp `1px` bottom border.
*   **Anchored Footer:** Always 100% width, fixed to the bottom. Use the same background as the header and a `1px` top border.
*   **The Horizon Line:** Ensure that horizontal dividers in different panes (e.g., Left Editor vs. Right Sidebar) align on the exact same pixel to create a continuous "Horizon."

### B. Split-Pane Architecture
*   **The Divide:** Use vertical borders (`border-r`) rather than margins to separate columns.
*   **Visual Hierarchy:**
    *   **The Canvas (White):** Where the primary work happens (Prompting, Spec Reading).
    *   **The Inspector (Tinted):** Where secondary context lives (File lists, Analytics, Chat Assistant). Use `bg-slate-50` (#F8FAFC).

---

## 3. Visual Vocabulary
### A. Monospace "Code Chips"
Any text representing a technical object must be styled as a chip:
*   **Entities:** Repository names, Issue IDs (`#732`), PR numbers, Branch names, File paths.
*   **Style:** `font-mono`, `text-xs`, `bg-slate-100`, `text-slate-700`, `rounded-sm`.

### B. Status & Color Logic
*   **Implementing/Active:** Solid **Brand Teal** or **Blue**. Indicates the machine is working.
*   **Needs Review/Attention:** **Amber Outline**. Indicates a human is the bottleneck (e.g., Unmerged PR).
*   **Completed/Merged:** **Neutral Gray** text + checkmark. No background.
*   **Failed:** **Red** text/pill.

### C. Quality Metrics (Shapes)
Use geometric shapes to indicate quality tiers (Lighthouse metaphor):
*   **9-10:** Teal Circle `●`
*   **7-8:** Slate Diamond `◆`
*   **5-6:** Amber Square `■`
*   **0-4:** Red Triangle `▲`

---

## 4. Typography
*   **Standard Text:** Use a modern sans-serif stack (Inter, System Sans).
*   **Titles:** Use `font-semibold` or `font-medium` (500). Avoid pure black; use `text-slate-900`.
*   **Metadata Labels:** Use `text-[10px] font-bold uppercase tracking-wider text-slate-500`.
*   **Readability:** For long-form text (Specs/Prompts), cap the line length at `65ch` or `750px` for comfortable reading, even if the container is wider.

---

## 5. Components & Interactions
### A. High-Density Lists (Activity Stream)
*   **Two-Line Row:** 
    *   Line 1: Metadata (Repo, ID, Time) in Gray/Regular weight.
    *   Line 2: Title in Black/Medium weight.
*   **Alignment:** Pin metadata (Timestamps/Durations) to the far right edge.
*   **Threading:** Use a `2px` vertical gray rail in the left gutter to visually connect sub-tasks or follow-ups to a parent task.

### B. "Studio" Dropdowns (Mega-Menus)
*   **Dimensions:** Wide (`600px`) and Tall (`max-height: 70vh`).
*   **Shadows:** Use a deep, soft shadow (`shadow-2xl`) or a subtle "Hard" shadow to provide depth.
*   **Tabs:** When a dropdown is open, the header trigger should have `0px` gap from the menu and a matching background color to look like a connected tab.

### C. Input Areas (The Composer)
*   **Rich Input:** Group text and attachments in a single white container.
*   **Attachments:** Display as dismissible "chips" at the bottom of the input area.
*   **Command Bar:** The primary button (Generate/Implement) should be pinned to the bottom-right of the input zone, or grouped logically on the left if part of a spec review.

### D. Loading & Processing
*   **Locking:** During AI generation, apply a semi-transparent overlay to the workspace to prevent editing.
*   **Progress:** Display a step-based progress list (e.g., "1/3 Analyzing...") in the center of the workspace.
*   **Animation:** Use a subtle pulse on active numbers and a rotating loader icon for running states.

---

## 6. CSS Utility Standards (Tailwind Examples)
*   **Borders:** `border-slate-200` (standard), `border-slate-100` (subtle).
*   **Backgrounds:** `bg-white` (canvas), `bg-slate-50` (sidebar/header).
*   **Stealth Scrollbars:**
    ```css
    .scrollbar-stealth::-webkit-scrollbar { width: 6px; }
    .scrollbar-stealth::-webkit-scrollbar-thumb { background: transparent; }
    .scrollbar-stealth:hover::-webkit-scrollbar-thumb { background: #CBD5E1; }
    ```

## 7. Form & Input Layouts
*   **Horizontal Layout (Settings/Complex Config):** For technical settings, use a horizontal split.
    *   **Left (40%):** Label + Subtext (Technical description in small, light gray font).
    *   **Right (60%):** Input/Dropdown.
*   **Input Suffixes:** Place "Add" or "Clear" buttons **inside** the input field border as clickable icons or text-links to save horizontal space and reduce "button fatigue."
*   **Segmented Controls:** For choices with 2-4 options (like "Granularity" or "Agent Type"), use a **Pill-Toggle** (Segmented Control) instead of a dropdown. It's faster to click.

## 8. Global Search & Navigation
*   **Global Search Bar:** Fixed width (`max-w-[400px]`), centered or right-aligned. 
    *   **Visual:** Light gray background, borderless.
    *   **Cue:** Show a subtle `⌘K` or `Ctrl+K` shortcut hint on the far right of the bar.
*   **Breadcrumbs:** Use Repo/Branch breadcrumbs as the "Title" of the workspace.
    *   **Format:** `📂 repo-name / branch ▾`.
    *   Make the entire string a dropdown trigger for switching context.

## 9. Proactive Empty States (The "Launchpad")
*   **Logic:** Never show a "No results found" screen with a dead end.
*   **Layout:**
    *   **Icon:** Large, centered, low-opacity gray icon.
    *   **Headline:** Friendly but technical (e.g., "All caught up").
    *   **Primary CTA:** A prominent **Brand Teal** button to start the next logical step in the workflow (e.g., "+ Generate AI Plan").
    *   **Secondary CTA:** A gray link to view history or documentation.

## 10. Responsive Density (The "13-inch Laptop" Rule)
*   **Adaptive Truncation:**
    *   **File Paths:** Use **Middle-Truncation** (`src/.../utils.ts`) or **Two-Line** display (Filename Bold / Path Dimmed). Never truncate the filename itself.
    *   **Titles:** Ensure titles use the full available width of their container before showing an ellipsis.
*   **Density Scaling:** On screens under 1400px, reduce global padding from `p-6` to `p-4` and reduce row padding in lists to keep data above the fold.

## 11. Iconography
*   **Consistency:** Icons in the Global Header must match the Sidebar icons exactly for the same categories (Plans, Tasks).
*   **Tone:** Use monotone, thin-stroke icons (Lucide-React standard). 
*   **Visual Weight:** Icons should generally be `14px` to `16px`. They are visual anchors, not focal points.

---

### Final "Checklist" for every PR:
1.  **Is it "Cardy"?** If yes, remove the box and use a divider line.
2.  **Is it "Green"?** If it's a finished task, make it gray.
3.  **Is it "Airy"?** If there's too much whitespace, increase the density.
4.  **Is it "Technical"?** If it's an ID or path, use the Mono Chip.


---

## 12. AI Streaming & Real-time Feedback
*   **The "Living" UI:** When the AI is generating text (Plans or Chat), the container should not "jump" as text is added. 
    *   *Fix:* Use an **Anchored Scroll** logic where the view follows the new text automatically if the user is at the bottom.
*   **Streaming Indicator:** While the AI is "typing," show a subtle **pulsing cursor** (`▋`) or a small "AI is typing..." indicator in the footer of the pane.
*   **Confidence Scores:** When displaying AI-suggested files or logic, use the **Percentage Progress Bar** (from our file list) to show confidence levels.

## 13. System Overlays (Panels vs. Modals)
*   **The "Side-Pane first" Rule:** For any action that requires context from the main screen (e.g., viewing a Plan's original prompt or editing a specific Task), use a **Slide-over Right Panel** instead of a centered Modal.
    *   *Why:* Modals block the work; Side-Panes allow the user to reference the main canvas while they work in the pane.
*   **When to use Modals:** Use centered Modals only for **destructive actions** (Delete confirmation) or **disconnected setup** (Adding a new Repo/Agent).

## 14. Keyboard Ergonomics
*   **Shortcuts:** Developers prioritize keyboard over mouse.
    *   `⌘ + K` (or `Ctrl + K`): Focus Global Search.
    *   `⌘ + Enter`: Primary Action (Generate Plan / Send Message / Implement).
    *   `Esc`: Close dropdowns/panels.
*   **Focus States:** Ensure every interactive element has a high-contrast focus ring (e.g., `focus:ring-2 focus:ring-teal-500`). In a technical tool, you should always know where your keyboard focus is.

## 15. Error & Failure States
*   **The "Retry" Loop:** If an AI implementation fails (Red Badge), the card must immediately offer a **`↺ Retry`** button and a **`💬 Ask Assistant why`** button.
*   **Inline Errors:** Never use generic "Something went wrong" popups. Place the error text directly inside the affected component (e.g., inside the specific task card) so the user sees the context.

