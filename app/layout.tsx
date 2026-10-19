import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SeatNerd — live ticketing",
  description: "SeatNerd prototype: US live-event ticketing powered by Juspay Hyperswitch",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <style>{`@keyframes blink { 0%,100% { opacity: .85 } 50% { opacity: .4 } } @keyframes pop { 0% { transform: scale(.97) } 60% { transform: scale(1.01) } 100% { transform: scale(1) } } @keyframes pulseRing { 0% { box-shadow: 0 0 0 0 rgba(252,200,0,.5) } 100% { box-shadow: 0 0 0 14px rgba(252,200,0,0) } }
button, select, a { outline: none }
button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid #8EC5FF; outline-offset: 2px }
button { transition: transform .15s cubic-bezier(.2,0,0,1), background-color .15s, border-color .15s, color .15s, opacity .15s }
button:active { transform: scale(.96) }
* { -webkit-font-smoothing: antialiased }`}</style>
      </head>
      <body style={{ margin: 0, background: "#0b0d12", color: "#e6e9f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
