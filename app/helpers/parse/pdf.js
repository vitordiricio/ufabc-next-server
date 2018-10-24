const _ = require('lodash')
let fs = require('fs')
const PDFParser = require("pdf2json")
const Axios = require('axios')
const errors = require('@/errors')
const { PassThrough } = require('stream')

_.insert = function (arr, index, item) {
  arr.splice(index, 0, item)
}

function parsePDF(buffer, params) {
  let pdfParser = new PDFParser()

  pdfParser.parseBuffer(buffer)

  return new Promise((resolve, reject) => {
     pdfParser.on("pdfParser_dataReady", function(pdfData) {
      function closest (num, arr) {
        var curr = arr[0]
        var diff = Math.abs (num - curr)
        for (var val = 0; val < arr.length; val++) {
          var newdiff = Math.abs (num - arr[val])
          if (newdiff < diff) {
            diff = newdiff
            curr = arr[val]
          }
        }
        return curr
      }

      var pages = pdfData.formImage.Pages

      const diffs = []
      let rows = []

      pages.forEach(page => {
        let lastCombined = 0

        page.Texts.forEach(pageText => {
          let roundedY = Math.round(pageText.y)
          let roundedX = Math.round(pageText.x)

          let roudedCombined = Math.abs(roundedX + roundedY)

          let diff = Math.abs(roudedCombined - lastCombined)
          diffs.push(diff)
          rows.push(roundedX)
          lastCombined = roudedCombined
        })
      })

      let v = _(rows)
        .countBy()
        .toPairs()
        .sortBy([a => -1 * a[1]])
        .value()

      let maxOccurences = v[0][1]
      let bestMatches = (maxOccurences * params.allowedPercentage)
      let rowsPositions = v.filter(v => v[1] >= bestMatches).map(v => parseInt(v[0]))

      const firstPosition = _.min(rowsPositions)
      const lastPosition = _.max(rowsPositions)

      const results = []
      let tmp = {}
      let position = 0

      pages.forEach((page, index) => {
        if(index < params.startPage) return
        let lastCombined = 0

        page.Texts.forEach(text => {
          let roundedY = Math.round(text.y)
          let roundedX = Math.round(text.x)

          let roudedCombined = Math.abs(roundedX + roundedY)

          let diff = Math.abs(roudedCombined - lastCombined)

          let isFirst = Math.abs(firstPosition - roundedX) < params.rowDifference
          let isLast = Math.abs(lastPosition - roundedX) < params.rowDifference

          // same cell
          if(diff < 2 && position > 0) {
            tmp[position - 1].text += ' ' + decodeURIComponent(text.R[0].T)
          } 
          // different payload
          else if(isFirst) {
            results.push(tmp)
            tmp = {}
            position = 0
            tmp[position++] = {
              text: decodeURIComponent(text.R[0].T),
              pos: roundedX,
            }
          } else if(isLast) {
            tmp[position++] = {
              text: decodeURIComponent(text.R[0].T),
              pos: roundedX,
            }

            results.push(tmp)
            tmp = {}
            position = 0
          } else if(roundedX <= lastPosition + 1) {
            tmp[position++] = {
              text: decodeURIComponent(text.R[0].T),
              pos: roundedX,
            }
          }

          lastCombined = roudedCombined
        })
      })

      const sortedResults = _.sortBy(results, [(o) => _.values(o).length]).reverse()

      let columnsTitles = _.values(sortedResults[0])
      let maxLength = columnsTitles.length
      if(maxLength != params.numberOfColumns) {
        reject(new errors.BadRequest(JSON.stringify(v)))
      }

      const positionAverage = {}
      const availablePositions = []

      sortedResults.forEach(result => {
        let tmp = _.values(result)
        if(tmp.length == maxLength) {
          _.map(tmp, 'pos').forEach((pos, i) => {
            positionAverage[i] = positionAverage[i] || []
            positionAverage[i].push(pos)

            availablePositions.push(pos)
          })
        }
      })

      const positionAverageArray = _(positionAverage)
        .mapValues((value, key) => _.mean(value))
        .values()
        .value()

      const finalResults = []

      sortedResults.forEach(result => {
        let tmp = _.values(result)

        tmp = _.map(tmp, (value, key) => {
          value.pos = Math.floor(closest(value.pos, positionAverageArray))
          return value
        })

        let cleaned = _.map(positionAverageArray, Math.floor)
        
        let diff = _.difference(cleaned, tmp.map(p => p.pos))
        
        if(diff.length <= 4) {
          diff.forEach(p => {
            let emptyPos = cleaned.indexOf(p)
            _.insert(tmp, emptyPos, {
              text: null,
              pos: p
            })
          })

          tmp = tmp.reduce((acc, property, index) => {
            if(!_.map(params.pickColumns, 'position').includes(index)) return acc
            acc[_.find(params.pickColumns, { position: index }).name] = property.text
            return acc
          }, {})

          finalResults.push(tmp)
        }
      })
     
      resolve(finalResults)
    })
  })
}

module.exports = async function (body) {
  const params = _.defaults(body, {
    link: 'http://prograd.ufabc.edu.br/pdf/turmas_salas_docentes_sa_2018.3.pdf',
    numberOfColumns: 6,
    startPage: 0,
    pickColumns: [{
      position: 0,
      name: 'ra'
    }],
    rowDifference: 5,
    allowedPercentage: 0.3
  })

  const response = await Axios({
    method: 'GET',
    url: params.link,
    responseType: 'stream'
  })

  const forBuffer = new PassThrough()
  const buffers = []

  return new Promise((resolve, reject) => {
    response.data.pipe(forBuffer)
    forBuffer.on('data', chunk => buffers.push(chunk))
    forBuffer.on('finish', chunk => {
      parsePDF(Buffer.concat(buffers), params).then(r => {
        resolve(r)
      }).catch(e => {
        reject(e)
      })
    })
  })
}