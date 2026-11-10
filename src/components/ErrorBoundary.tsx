import { Component, type ReactNode } from 'react'

interface Props {
  resetKey: string
  children: ReactNode
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <section role="alert" className="card max-w-lg mx-auto mt-8 space-y-3">
        <h1 className="text-xl font-semibold">Algo falló en esta pantalla</h1>
        <p>El resto de la consola sigue disponible.</p>
        <a className="btn inline-block" href="/">
          Volver al inicio
        </a>
      </section>
    )
  }
}
