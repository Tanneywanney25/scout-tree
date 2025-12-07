import * as React from "react";
import { format, parse, isValid } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateInputProps {
  date: Date | undefined;
  onDateChange: (date: Date | undefined) => void;
  placeholder?: string;
  className?: string;
}

export function DateInput({ date, onDateChange, placeholder = "MM/DD/YYYY", className }: DateInputProps) {
  const [inputValue, setInputValue] = React.useState<string>("");
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  // Sync input value with date prop
  React.useEffect(() => {
    if (date) {
      setInputValue(format(date, "MM/dd/yyyy"));
      setInputError(null);
    } else {
      setInputValue("");
    }
  }, [date]);

  const parseInputDate = (value: string): Date | null => {
    // Try MM/DD/YYYY format
    const cleanValue = value.trim();
    
    if (!cleanValue) return null;
    
    // Match MM/DD/YYYY pattern
    const match = cleanValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    
    const [, monthStr, dayStr, yearStr] = match;
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    const year = parseInt(yearStr, 10);
    
    // Validate ranges
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (year < 1900 || year > 2100) return null;
    
    // Create date and validate it's real (e.g., not Feb 30)
    const parsedDate = new Date(year, month - 1, day);
    if (!isValid(parsedDate)) return null;
    
    // Verify the date didn't roll over (e.g., Feb 30 becomes Mar 2)
    if (parsedDate.getMonth() !== month - 1 || parsedDate.getDate() !== day) {
      return null;
    }
    
    return parsedDate;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    
    // Clear error while typing
    if (inputError) setInputError(null);
    
    // Try to parse the date
    if (value.length === 10) { // Full date entered
      const parsedDate = parseInputDate(value);
      if (parsedDate) {
        onDateChange(parsedDate);
        setInputError(null);
      } else {
        setInputError("Invalid date");
      }
    } else if (value === "") {
      onDateChange(undefined);
    }
  };

  const handleInputBlur = () => {
    if (inputValue && inputValue.length > 0 && inputValue.length !== 10) {
      setInputError("Use MM/DD/YYYY format");
    } else if (inputValue.length === 10) {
      const parsedDate = parseInputDate(inputValue);
      if (!parsedDate) {
        setInputError("Invalid date");
      }
    }
  };

  const handleCalendarSelect = (selectedDate: Date | undefined) => {
    onDateChange(selectedDate);
    setOpen(false);
  };

  return (
    <div className={cn("flex gap-1", className)}>
      <div className="flex-1 relative">
        <Input
          type="text"
          placeholder={placeholder}
          value={inputValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          className={cn(
            "text-sm",
            inputError && "border-destructive focus-visible:ring-destructive"
          )}
        />
        {inputError && (
          <p className="text-xs text-destructive mt-1 absolute">{inputError}</p>
        )}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              "shrink-0",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent 
          className="w-auto p-0 bg-popover" 
          align="start"
          side="bottom"
          sideOffset={4}
          avoidCollisions={false}
        >
          <Calendar
            mode="single"
            selected={date}
            onSelect={handleCalendarSelect}
            initialFocus
            className="pointer-events-auto"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
