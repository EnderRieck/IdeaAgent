import type { Tool } from "../../capabilities/tools/types";
import type { ToolCatalog } from "../../capabilities/tools/tool-setup";
import { arxivSearchTool } from "./tools/arxiv-search";
import { localCliTool } from "./tools/local-cli";
import { mineruParseTool } from "./tools/mineru-parse";
import { openAlexSearchTool } from "./tools/openalex-search";
import { pdfParseBasicTool } from "./tools/pdf-parse-basic";
import { pythonExecTool } from "./tools/python-exec";
import { readSessionFilesTool } from "./tools/read-session-files";
import { researchNotebookTool } from "./tools/research-notebook";
import { scientificCalculatorTool } from "./tools/scientific-calculator";
import { venueSearchTool } from "./tools/venue-search";
import { webFetchTool } from "./tools/web-fetch";
import { webSearchTool } from "./tools/web-search";

export const builtinToolCatalog: ToolCatalog = {
  "arxiv-search": arxivSearchTool,
  "local-cli": localCliTool,
  "mineru-parse": mineruParseTool,
  "openalex-search": openAlexSearchTool,
  "pdf-parse-basic": pdfParseBasicTool,
  "python-exec": pythonExecTool,
  "read-session-files": readSessionFilesTool,
  "research-notebook": researchNotebookTool,
  "scientific-calculator": scientificCalculatorTool,
  "venue-search": venueSearchTool,
  "web-fetch": webFetchTool,
  "web-search": webSearchTool,
};

export const builtinToolList: Tool[] = Object.values(builtinToolCatalog);
