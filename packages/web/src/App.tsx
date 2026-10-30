import { Route, Routes } from "react-router-dom";
import { ArenaLab } from "./lab/ArenaLab.tsx";
import { HeartsLab } from "./lab/HeartsLab.tsx";
import { Lobby } from "./lobby/Lobby.tsx";
import { RoomView } from "./room/RoomView.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Lobby />} />
      <Route path="/room/:code" element={<RoomView />} />
      <Route path="/lab/hearts" element={<HeartsLab />} />
      <Route path="/lab/arena" element={<ArenaLab />} />
    </Routes>
  );
}
