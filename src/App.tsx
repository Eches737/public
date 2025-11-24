import { useState } from "react"
import './App.css'
import { summarizeText } from './api/ai'

function App() {
  const [input, setInput] = useState("")
  const [summary, setSummary] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSummarize = async () => {
    setLoading(true)
    try {
      const result = await summarizeText(input)
      setSummary(result)
    } catch (e) {
      alert("AI 요약 중 오류가 발생했습니다.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Ref Paper – AI 요약 테스트</h1>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="논문 텍스트 일부를 붙여넣고 AI 요약하기를 눌러보세요."
        style={{ width: "100%", height: "150px" }}
      />
      <button onClick={handleSummarize} disabled={loading} style={{ marginTop: "0.5rem" }}>
        {loading ? "요약 중..." : "AI 요약하기"}
      </button>

      {summary && (
        <div style={{ marginTop: "1rem", whiteSpace: "pre-wrap" }}>
          <h2>요약 결과</h2>
          <p>{summary}</p>
        </div>
      )}
    </div>
  )
}

export default App
