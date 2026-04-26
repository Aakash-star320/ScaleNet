import './globals.css'

export const metadata = {
  title: 'ScaleNet | Operations',
  description: 'Premium Real-time Operations Dashboard for ScaleNet',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
