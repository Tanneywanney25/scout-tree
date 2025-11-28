import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getOpeningName } from "@/lib/openings";

interface SerializedOpeningNode {
  move: string;
  san: string;
  count: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  children?: any[]; // Serialized children array
  key?: string;
}

interface OpeningTreeViewerProps {
  node: SerializedOpeningNode;
  depth?: number;
  maxDepth?: number;
  onMoveClick?: (movePath: string[]) => void;
  selectedPath?: string[];
  currentPath?: string[];
}

const OpeningTreeNode = ({ 
  node, 
  depth = 0, 
  maxDepth = 10, 
  onMoveClick,
  selectedPath = [],
  currentPath = []
}: OpeningTreeViewerProps) => {
  const [isExpanded, setIsExpanded] = useState(depth < 2); // Auto-expand first 2 levels
  
  // Convert children from array format to actual array if needed
  const children = Array.isArray(node.children) 
    ? node.children 
    : [];
  
  const hasChildren = children.length > 0;
  const shouldShowChildren = depth < maxDepth;
  
  // Check if this node is selected
  const isSelected = selectedPath.length === depth && 
    selectedPath.every((san, i) => currentPath[i] === san) &&
    (depth === 0 || selectedPath[depth - 1] === node.san);
  
  // Build the path to this node
  const thisPath = depth === 0 ? [] : [...currentPath, node.san];
  
  // Get opening name for this position
  const openingName = thisPath.length > 0 ? getOpeningName(thisPath) : null;

  const getWinRateColor = (winRate: number) => {
    if (winRate >= 0.6) return "text-green-600 dark:text-green-400";
    if (winRate >= 0.45) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  const getWinRateBadge = (winRate: number) => {
    if (winRate >= 0.6) return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
    if (winRate >= 0.45) return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
    return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
  };

  // Skip rendering root node
  if (depth === 0 && node.san === "Start") {
    return (
      <div className="space-y-1">
        {children.map((child, index) => (
          <OpeningTreeNode
            key={child.key || index}
            node={child}
            depth={1}
            maxDepth={maxDepth}
            onMoveClick={onMoveClick}
            selectedPath={selectedPath}
            currentPath={[]}
          />
        ))}
      </div>
    );
  }
  
  const handleClick = () => {
    if (onMoveClick) {
      onMoveClick(thisPath);
    }
  };

  return (
    <div className="space-y-1">
      <div
        className={cn(
          "group flex items-center gap-2 py-2 px-3 rounded-lg transition-colors cursor-pointer",
          isSelected ? "bg-primary/20 hover:bg-primary/30" : "hover:bg-muted/50",
          depth > 0 && "ml-6"
        )}
        style={{ marginLeft: depth > 0 ? `${(depth - 1) * 24}px` : 0 }}
        onClick={handleClick}
      >
        {/* Expand/Collapse Button */}
        {hasChildren && shouldShowChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="shrink-0 hover:bg-muted rounded p-0.5 transition-colors flex items-center justify-center"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        ) : (
          <div className="w-5" />
        )}

        {/* Move Number */}
        <span className="text-xs text-muted-foreground font-medium shrink-0 w-8">
          {Math.floor(depth / 2) + 1}.
          {depth % 2 === 1 ? "" : ".."}
        </span>

        {/* Move in SAN notation */}
        <code className="font-mono text-sm font-semibold text-foreground min-w-[60px]">
          {node.san}
        </code>

        {/* Opening Name */}
        {openingName && (
          <Badge variant="outline" className="text-xs shrink-0 bg-primary/10 text-primary border-primary/20">
            {openingName}
          </Badge>
        )}

        {/* Frequency Badge */}
        <Badge variant="secondary" className="text-xs shrink-0">
          {node.count} {node.count === 1 ? "game" : "games"}
        </Badge>

        {/* Win Rate */}
        <div className="flex items-center gap-1 ml-auto">
          <span className={cn("text-xs font-medium", getWinRateColor(node.winRate))}>
            {(node.winRate * 100).toFixed(0)}%
          </span>
          <Badge className={cn("text-xs", getWinRateBadge(node.winRate))}>
            +{node.wins} ={node.draws} -{node.losses}
          </Badge>
        </div>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && shouldShowChildren && (
        <div className="animate-accordion-down">
          {children
            .sort((a, b) => b.count - a.count) // Sort by frequency
            .map((child, index) => (
              <OpeningTreeNode
                key={child.key || index}
                node={child}
                depth={depth + 1}
                maxDepth={maxDepth}
                onMoveClick={onMoveClick}
                selectedPath={selectedPath}
                currentPath={thisPath}
              />
            ))}
        </div>
      )}
    </div>
  );
};

export const OpeningTreeViewer = ({ 
  node, 
  maxDepth = 10, 
  onMoveClick,
  selectedPath 
}: Omit<OpeningTreeViewerProps, 'depth' | 'currentPath'>) => {
  return (
    <div className="space-y-1">
      <OpeningTreeNode 
        node={node} 
        depth={0} 
        maxDepth={maxDepth} 
        onMoveClick={onMoveClick}
        selectedPath={selectedPath}
      />
    </div>
  );
};

export default OpeningTreeViewer;
