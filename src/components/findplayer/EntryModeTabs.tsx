import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { User, Trophy, AtSign } from "lucide-react";

export type EntryMode = "person" | "tournament" | "handle";

interface EntryModeTabsProps {
  mode: EntryMode;
  onModeChange: (mode: EntryMode) => void;
  personContent: React.ReactNode;
  tournamentContent: React.ReactNode;
  handleContent: React.ReactNode;
}

/**
 * The three doors into Find Player, matching the three real situations users
 * are in: "I know a name" (default), "I'm playing in an event", and "I already
 * know their username" — the last of which used to be buried inside the
 * no-match empty state, i.e. the fastest path was only offered after failing.
 */
export function EntryModeTabs({ mode, onModeChange, personContent, tournamentContent, handleContent }: EntryModeTabsProps) {
  return (
    <Tabs value={mode} onValueChange={(v) => onModeChange(v as EntryMode)}>
      <TabsList className="grid w-full grid-cols-3 h-11">
        <TabsTrigger value="person" className="gap-1.5">
          <User className="w-4 h-4" />
          Person
        </TabsTrigger>
        <TabsTrigger value="tournament" className="gap-1.5">
          <Trophy className="w-4 h-4" />
          Tournament
        </TabsTrigger>
        <TabsTrigger value="handle" className="gap-1.5">
          <AtSign className="w-4 h-4" />
          I have a handle
        </TabsTrigger>
      </TabsList>
      <TabsContent value="person" className="mt-5">
        {personContent}
      </TabsContent>
      <TabsContent value="tournament" className="mt-5">
        {tournamentContent}
      </TabsContent>
      <TabsContent value="handle" className="mt-5">
        {handleContent}
      </TabsContent>
    </Tabs>
  );
}

export default EntryModeTabs;
