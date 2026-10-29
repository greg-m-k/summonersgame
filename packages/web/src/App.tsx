import { Route, Routes } from "react-router-dom";
import { Lobby } from "./lobby/Lobby.tsx";
import { RoomView } from "./room/RoomView.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Lobby />} />
      <Route path="/room/:code" element={<RoomView />} />
    </Routes>
  );
}
