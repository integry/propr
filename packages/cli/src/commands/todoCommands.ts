/**
 * Repository To-Do Commands
 *
 * CLI commands for managing repository-level to-dos.
 * Provides the `todo` command group with `list`, `get`, `add`, `complete`, `delete` subcommands.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { resolveProject, ProjectResolutionError, printOutput } from "../utils/index.js";
import {
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderTodos,
  reorderCategories,
  RepoTodo,
  RepoTodoCategory,
} from "../api/index.js";

/**
 * Truncates a string to a maximum length.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "-";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Displays a table of todos grouped by category.
 */
function displayTodosTable(todos: RepoTodo[], categories: RepoTodoCategory[]): void {
  const categoryMap = new Map<string, string>();
  for (const cat of categories) {
    categoryMap.set(cat.categoryId, cat.name);
  }

  const idWidth = Math.max(
    "ID".length,
    ...todos.map((t) => t.todoId.length)
  );
  const contentWidth = Math.max(
    "Content".length,
    ...todos.map((t) => truncate(t.content, 50).length)
  );
  const categoryWidth = Math.max(
    "Category".length,
    ...todos.map((t) => truncate(t.categoryId ? categoryMap.get(t.categoryId) || t.categoryId : "(none)", 20).length)
  );
  const statusWidth = "Status".length;

  const header = [
    "ID".padEnd(idWidth),
    "Content".padEnd(contentWidth),
    "Category".padEnd(categoryWidth),
    "Status".padEnd(statusWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const todo of todos) {
    const categoryName = todo.categoryId
      ? categoryMap.get(todo.categoryId) || todo.categoryId
      : "(none)";
    const status = todo.isCompleted ? "Done" : "Open";

    const row = [
      todo.todoId.padEnd(idWidth),
      truncate(todo.content, 50).padEnd(contentWidth),
      truncate(categoryName, 20).padEnd(categoryWidth),
      status.padEnd(statusWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Displays detailed todo information.
 */
function displayTodoDetails(todo: RepoTodo): void {
  console.log("");
  console.log("=".repeat(60));
  console.log("To-Do Details");
  console.log("=".repeat(60));
  console.log("");

  console.log(`ID:          ${todo.todoId}`);
  console.log(`Content:     ${todo.content}`);
  console.log(`Status:      ${todo.isCompleted ? "Completed" : "Open"}`);
  console.log(`Category:    ${todo.categoryId || "(none)"}`);
  console.log(`Created:     ${new Date(todo.createdAt).toLocaleString()}`);
  console.log(`Updated:     ${new Date(todo.updatedAt).toLocaleString()}`);

  if (todo.linkedDraftId) {
    console.log(`Linked Plan: ${todo.linkedDraftId}`);
  }

  console.log("");
  console.log("=".repeat(60));
}

/**
 * Prompts the user for confirmation.
 */
async function confirm(message: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Creates the `todo` command group.
 */
export function createTodoCommand(): Command {
  const todo = new Command("todo")
    .description("Manage repository to-dos")
    .addHelpText("after", `
Examples:
  $ propr todo list                          # List todos for default project
  $ propr todo get <todo-id>                 # View todo details
  $ propr todo add "Fix login page"          # Create a todo
  $ propr todo complete <todo-id>            # Mark as completed
  $ propr todo delete <todo-id>              # Delete a todo
`);

  // todo list
  todo
    .command("list")
    .description("List to-dos for a repository")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-a, --all", "Show all todos (open and completed)")
    .option("-d, --done", "Show only completed todos")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr todo list                    # Open todos for default project
  $ propr todo list -a                 # All todos (open + completed)
  $ propr todo list -d                 # Completed todos only
  $ propr todo list -p myorg/myrepo    # Specify project
  $ propr todo list --json             # JSON output
`)
    .action(async (options: { project?: string; all?: boolean; done?: boolean; json?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        const [todosResult, categoriesResult] = await Promise.all([
          listTodos(project),
          listCategories(project),
        ]);

        let todos = todosResult.todos || [];
        const categories = categoriesResult.categories || [];

        if (options.done) {
          todos = todos.filter((t) => t.isCompleted);
        } else if (!options.all) {
          todos = todos.filter((t) => !t.isCompleted);
        }

        if (printOutput({ todos, categories }, options.json ?? false)) {
          return;
        }

        const filterLabel = options.done ? "completed " : options.all ? "" : "open ";

        if (todos.length === 0) {
          console.log(`No ${filterLabel}to-dos found for project: ${project}`);
          console.log("");
          console.log("To add a to-do, use:");
          console.log("  propr todo add \"<content>\"");
          return;
        }

        console.log(`To-dos for ${project}:`);
        console.log("");
        displayTodosTable(todos, categories);

        console.log("");
        if (options.all) {
          const openCount = todos.filter((t) => !t.isCompleted).length;
          const doneCount = todos.filter((t) => t.isCompleted).length;
          console.log(`Total: ${todos.length} to-do(s) (${openCount} open, ${doneCount} completed)`);
        } else {
          console.log(`Total: ${todos.length} ${filterLabel}to-do(s)`);
        }
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error listing to-dos: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // todo get
  todo
    .command("get <todo-id>")
    .description("Get detailed information about a specific to-do")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  todo-id    The unique identifier of the to-do

Examples:
  $ propr todo get abc123-def456
  $ propr todo get abc123-def456 --json
`)
    .action(async (todoId: string, options: { json?: boolean }) => {
      try {
        const result = await getTodo(todoId);

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        displayTodoDetails(result);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: To-do not found: ${todoId}`);
        } else if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else {
          console.error(`Error fetching to-do: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // todo add
  todo
    .command("add <content>")
    .description("Create a new to-do for a repository")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-c, --category <categoryId>", "Category ID to assign the to-do to")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  content    The to-do content/description

Examples:
  $ propr todo add "Fix login page styling"
  $ propr todo add "Add unit tests" -p myorg/myrepo
  $ propr todo add "Refactor auth" -c category-uuid --json
`)
    .action(async (content: string, options: { project?: string; category?: string; json?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        const result = await createTodo({
          repository: project,
          content,
          categoryId: options.category || null,
        });

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("To-do created successfully!");
        console.log(`  ID:      ${result.todoId}`);
        console.log(`  Content: ${result.content}`);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error creating to-do: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // todo complete
  todo
    .command("complete <todo-id>")
    .description("Mark a to-do as completed")
    .option("--undo", "Mark a completed to-do as open again")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  todo-id    The unique identifier of the to-do

Examples:
  $ propr todo complete abc123          # Mark as done
  $ propr todo complete abc123 --undo   # Mark as open again
`)
    .action(async (todoId: string, options: { undo?: boolean; json?: boolean }) => {
      try {
        const isCompleted = !options.undo;
        const result = await updateTodo(todoId, { isCompleted });

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        const action = isCompleted ? "completed" : "reopened";
        console.log(`To-do ${action}: ${result.content}`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: To-do not found: ${todoId}`);
        } else if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else {
          console.error(`Error updating to-do: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // todo delete
  todo
    .command("delete <todo-id>")
    .description("Delete a to-do permanently")
    .option("-f, --force", "Skip confirmation prompt")
    .addHelpText("after", `
Argument:
  todo-id    The unique identifier of the to-do to delete

Examples:
  $ propr todo delete abc123           # With confirmation
  $ propr todo delete abc123 --force   # Skip confirmation
`)
    .action(async (todoId: string, options: { force?: boolean }) => {
      try {
        // Fetch the todo first to show what will be deleted
        let todoContent = todoId;
        try {
          const existing = await getTodo(todoId);
          todoContent = existing.content;
          console.log(`To-do: ${existing.content}`);
          console.log(`Status: ${existing.isCompleted ? "Completed" : "Open"}`);
          console.log("");
        } catch {
          console.log(`To-do ID: ${todoId}`);
          console.log("");
        }

        if (!options.force) {
          const confirmed = await confirm("Are you sure you want to delete this to-do?");
          if (!confirmed) {
            console.log("Deletion cancelled.");
            return;
          }
        }

        await deleteTodo(todoId);
        console.log("To-do deleted successfully.");
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: To-do not found: ${todoId}`);
        } else if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else {
          console.error(`Error deleting to-do: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // todo move
  todo
    .command("move <todo-id> <position>")
    .description("Move a to-do to a different position or category")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-c, --category <categoryId>", "Move to a different category (use 'none' for uncategorized)")
    .addHelpText("after", `
Arguments:
  todo-id     The to-do ID to move
  position    Target position (1-based)

Examples:
  $ propr todo move abc123 1                    # Move to top
  $ propr todo move abc123 3                    # Move to position 3
  $ propr todo move abc123 1 -c category-uuid   # Move to top of another category
  $ propr todo move abc123 1 -c none            # Move to uncategorized
`)
    .action(async (todoId: string, positionStr: string, options: { project?: string; category?: string }) => {
      try {
        const position = parseInt(positionStr, 10);
        if (isNaN(position) || position < 1) {
          console.error("Error: Position must be a positive integer (1-based).");
          process.exit(1);
        }

        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        // Fetch current todo to know its category
        const currentTodo = await getTodo(todoId);
        const targetCategoryId = options.category === "none"
          ? null
          : options.category ?? currentTodo.categoryId;

        // Fetch all todos to compute new order
        const todosResult = await listTodos(project);
        const allTodos = todosResult.todos || [];

        // Get todos in the target category, excluding the one being moved
        const categoryTodos = allTodos
          .filter((t) => t.categoryId === targetCategoryId && t.todoId !== todoId)
          .sort((a, b) => a.orderIndex - b.orderIndex);

        // Clamp position
        const clampedPos = Math.min(position, categoryTodos.length + 1);

        // Insert at the target position (1-based -> 0-based index)
        categoryTodos.splice(clampedPos - 1, 0, currentTodo);

        // Build reorder items
        const items = categoryTodos.map((t, i) => ({
          id: t.todoId,
          orderIndex: i,
          categoryId: targetCategoryId,
        }));

        await reorderTodos(project, items);

        const categoryLabel = targetCategoryId ?? "uncategorized";
        console.log(`Moved "${truncate(currentTodo.content, 40)}" to position ${clampedPos} in ${options.category ? categoryLabel : "its category"}.`);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: To-do not found: ${todoId}`);
        } else {
          console.error(`Error moving to-do: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // todo category (nested subcommand group)
  const category = new Command("category")
    .description("Manage to-do categories")
    .addHelpText("after", `
Examples:
  $ propr todo category list                    # List categories
  $ propr todo category add "Bug fixes"         # Create a category
  $ propr todo category rename <id> "New name"  # Rename a category
  $ propr todo category delete <id>             # Delete a category
`);

  // todo category list
  category
    .command("list")
    .description("List to-do categories for a repository")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr todo category list
  $ propr todo category list --json
`)
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        const result = await listCategories(project);
        const categories = result.categories || [];

        if (printOutput({ categories }, options.json ?? false)) {
          return;
        }

        if (categories.length === 0) {
          console.log(`No categories found for project: ${project}`);
          console.log("");
          console.log("To create a category, use:");
          console.log("  propr todo category add \"<name>\"");
          return;
        }

        console.log(`Categories for ${project}:`);
        console.log("");

        const idWidth = Math.max("ID".length, ...categories.map((c) => c.categoryId.length));
        const nameWidth = Math.max("Name".length, ...categories.map((c) => c.name.length));

        const header = `${"ID".padEnd(idWidth)}  ${"Name".padEnd(nameWidth)}`;
        console.log(header);
        console.log("-".repeat(header.length));

        for (const cat of categories) {
          console.log(`${cat.categoryId.padEnd(idWidth)}  ${cat.name.padEnd(nameWidth)}`);
        }

        console.log("");
        console.log(`Total: ${categories.length} category(ies)`);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error listing categories: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // todo category add
  category
    .command("add <name>")
    .description("Create a new to-do category")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  name    The category name

Examples:
  $ propr todo category add "Bug fixes"
  $ propr todo category add "Features" -p myorg/myrepo
`)
    .action(async (name: string, options: { project?: string; json?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        const result = await createCategory({ repository: project, name });

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("Category created successfully!");
        console.log(`  ID:   ${result.categoryId}`);
        console.log(`  Name: ${result.name}`);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error creating category: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // todo category rename
  category
    .command("rename <category-id> <name>")
    .description("Rename a to-do category")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Arguments:
  category-id    The category ID to rename
  name           The new name

Example:
  $ propr todo category rename abc123 "New name"
`)
    .action(async (categoryId: string, name: string, options: { json?: boolean }) => {
      try {
        const result = await updateCategory(categoryId, { name });

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log(`Category renamed to: ${result.name}`);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Category not found: ${categoryId}`);
        } else {
          console.error(`Error renaming category: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // todo category delete
  category
    .command("delete <category-id>")
    .description("Delete a to-do category (todos are moved to uncategorized)")
    .option("-f, --force", "Skip confirmation prompt")
    .addHelpText("after", `
Argument:
  category-id    The category ID to delete

Note:
  Todos in this category will be moved to uncategorized.

Examples:
  $ propr todo category delete abc123
  $ propr todo category delete abc123 --force
`)
    .action(async (categoryId: string, options: { force?: boolean }) => {
      try {
        if (!options.force) {
          const confirmed = await confirm("Are you sure you want to delete this category? Todos will be moved to uncategorized.");
          if (!confirmed) {
            console.log("Deletion cancelled.");
            return;
          }
        }

        await deleteCategory(categoryId);
        console.log("Category deleted successfully. Todos moved to uncategorized.");
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Category not found: ${categoryId}`);
        } else {
          console.error(`Error deleting category: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // todo category move
  category
    .command("move <category-id> <position>")
    .description("Move a category to a different position")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .addHelpText("after", `
Arguments:
  category-id    The category ID to move
  position       Target position (1-based)

Examples:
  $ propr todo category move abc123 1    # Move to top
  $ propr todo category move abc123 3    # Move to position 3
`)
    .action(async (categoryId: string, positionStr: string, options: { project?: string }) => {
      try {
        const position = parseInt(positionStr, 10);
        if (isNaN(position) || position < 1) {
          console.error("Error: Position must be a positive integer (1-based).");
          process.exit(1);
        }

        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        const result = await listCategories(project);
        const categories = (result.categories || []).sort((a, b) => a.orderIndex - b.orderIndex);

        const targetIndex = categories.findIndex((c) => c.categoryId === categoryId);
        if (targetIndex === -1) {
          console.error(`Error: Category not found: ${categoryId}`);
          process.exit(1);
        }

        const [moved] = categories.splice(targetIndex, 1);
        const clampedPos = Math.min(position, categories.length + 1);
        categories.splice(clampedPos - 1, 0, moved);

        const items = categories.map((c, i) => ({
          id: c.categoryId,
          orderIndex: i,
        }));

        await reorderCategories(project, items);

        console.log(`Moved category "${moved.name}" to position ${clampedPos}.`);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error moving category: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  todo.addCommand(category);

  return todo;
}
